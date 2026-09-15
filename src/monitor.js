'use strict';

/*
 * CEJN tender monitor
 * -------------------
 * Poziva javni endpoint CEJN portala (cejn.gov.me) koji vraca najnovije objavljene
 * tendere, filtrira ih po kljucnim rijecima iz src/keywords.json i salje email za
 * SVAKI novi pogodak. Vec vidjeni (poslati) tenderi se pamte u state/seen.json da
 * ne bi stizali duplikati.
 *
 * Pokretanje:
 *   node src/monitor.js         -> stvarni rad (salje email)
 *   node src/monitor.js --dry   -> samo ispis u konzolu, bez slanja emaila
 *
 * Potrebne env varijable za slanje emaila (SMTP; podrazumijevano Brevo):
 *   SMTP_USER   SMTP login (Brevo: SMTP & API -> SMTP -> "Login")
 *   SMTP_PASS   SMTP kljuc (Brevo: SMTP & API -> SMTP -> generisani kljuc)
 *   MAIL_FROM   verifikovani posiljalac, npr. "CEJN Monitor <ime@domen>"
 *   MAIL_TO     gdje da stigne obavjestenje (bilo koja adresa)
 *   SMTP_HOST   (opciono) default smtp-relay.brevo.com
 *   SMTP_PORT   (opciono) default 587
 */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// Ucitaj .env za lokalno testiranje. Na GitHub Actions varijable dolaze iz
// secrets-a (pravi process.env) i .env ne postoji — dotenv tada tiho ne radi
// nista, a postojece env varijable NIKAD ne prepisuje. Ako dotenv nije
// instaliran, oslanjamo se direktno na process.env.
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {
  /* dotenv nije instaliran — nema veze */
}

const API_URL = 'https://cejn.gov.me/api/cadocuments/GetTenders';
const TENDER_VIEW = 'https://cejn.gov.me/tenders/view-tender/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) cejn-monitor';

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'seen.json');
const KEYWORDS_FILE = path.join(__dirname, 'keywords.json');

const DRY_RUN = process.argv.includes('--dry') || process.env.DRY_RUN === '1';
const MAX_ITEMS = parseInt(process.env.MAX_ITEMS || '300', 10); // koliko najnovijih pregledati
const PAGE_SIZE = 50;

// --- pomocne funkcije -------------------------------------------------------

// Normalizuj tekst: mala slova, ukloni crnogorske dijakritike -> obican ascii.
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/đ/g, 'dj')
    .replace(/š/g, 's')
    .replace(/č/g, 'c')
    .replace(/ć/g, 'c')
    .replace(/ž/g, 'z')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // skini eventualne preostale akcente
}

function loadKeywords() {
  const raw = JSON.parse(fs.readFileSync(KEYWORDS_FILE, 'utf8'));
  return (raw.keywords || []).map((k) => normalize(k)).filter(Boolean);
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      firstRun: false,
      seen: new Set(raw.seen || []),
    };
  } catch (e) {
    return { firstRun: true, seen: new Set() };
  }
}

function saveState(seen) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // zadrzi najvise 5000 zadnjih id-jeva da fajl ne raste beskonacno
  const arr = Array.from(seen).slice(-5000);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ updated: new Date().toISOString(), seen: arr }, null, 2));
}

// Vrati koje se kljucne rijeci poklapaju sa naslovom (za prikaz u mejlu).
function matchedKeywords(title, keywords) {
  const t = normalize(title);
  return keywords.filter((k) => t.includes(k));
}

async function fetchNewest(maxItems) {
  const out = [];
  let skip = 0;
  while (out.length < maxItems) {
    const body = {
      pageSize: PAGE_SIZE,
      tenderStatuses: ['1', '512', '64', '4', '8'],
      skip,
      top: PAGE_SIZE,
      procedureType: 0,
      subjectType: 0,
      justCanApply: false,
      sort: null,
      myTenders: false,
      useAdditionalCaSearch: false,
      caType: 0,
      caStateId: 0,
      statuses: '1,512,64,4,8',
    };
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': UA,
        Origin: 'https://cejn.gov.me',
        Referer: 'https://cejn.gov.me/tenders',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('CEJN API HTTP ' + res.status);
    const json = await res.json();
    const items = json.value || [];
    out.push(...items);
    if (items.length < PAGE_SIZE) break; // doslo do kraja
    skip += PAGE_SIZE;
  }
  return out.slice(0, maxItems);
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}. ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildEmailHtml(hits, isBaseline) {
  const uvod = isBaseline
    ? 'Praćenje CEJN portala je pokrenuto. Trenutno otvoreni tenderi koji odgovaraju tvojim ključnim riječima:'
    : 'Nove objave na CEJN portalu koje odgovaraju tvojim ključnim riječima:';

  const rows = hits
    .map((h) => {
      const link = TENDER_VIEW + h.id;
      return `
      <tr>
        <td style="padding:12px 14px;border-bottom:1px solid #eee;vertical-align:top">
          <a href="${link}" style="font-size:15px;font-weight:600;color:#0b5cad;text-decoration:none">${escapeHtml(h.title)}</a>
          <div style="margin-top:6px;font-size:13px;color:#444">
            <strong>${escapeHtml(h.contractAuthority || '')}</strong>
          </div>
          <div style="margin-top:4px;font-size:12px;color:#777">
            ${escapeHtml(h.typeOfContractCaption || '')} &middot; ${escapeHtml(h.typeOfProcedureCaption || '')}
            &middot; objavljeno: ${formatDate(h.publishDate)}
            ${h.lifecycleCaption ? '&middot; ' + escapeHtml(h.lifecycleCaption) : ''}
          </div>
          <div style="margin-top:6px;font-size:11px;color:#999">
            pogodak: ${escapeHtml((h._matched || []).join(', '))} &middot;
            <a href="${link}" style="color:#0b5cad">otvori oglas &rarr;</a>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f6f8;font-family:Segoe UI,Arial,sans-serif">
    <div style="max-width:640px;margin:0 auto;padding:24px">
      <div style="background:#0b5cad;color:#fff;padding:16px 18px;border-radius:8px 8px 0 0">
        <div style="font-size:18px;font-weight:700">CEJN — nove javne nabavke</div>
        <div style="font-size:12px;opacity:.85">${escapeHtml(uvod)}</div>
      </div>
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:0 0 8px 8px;overflow:hidden">
        ${rows}
      </table>
      <div style="margin-top:14px;font-size:11px;color:#999;text-align:center">
        Automatsko obavještenje &middot; izvor: cejn.gov.me &middot; ${hits.length} rezultat(a)
      </div>
    </div>
  </body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendEmail(hits, isBaseline) {
  const host = process.env.SMTP_HOST || 'smtp-relay.brevo.com';
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.MAIL_TO;
  const from = process.env.MAIL_FROM || (user ? `CEJN Monitor <${user}>` : null);
  if (!user || !pass) {
    throw new Error('Nedostaju SMTP_USER / SMTP_PASS env varijable.');
  }
  if (!to) {
    throw new Error('Nedostaje MAIL_TO env varijabla (primalac).');
  }
  if (!from) {
    throw new Error('Nedostaje MAIL_FROM env varijabla (verifikovani posiljalac).');
  }
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465 = implicit TLS, 587 = STARTTLS
    auth: { user, pass },
  });
  const subject = isBaseline
    ? `CEJN praćenje pokrenuto — ${hits.length} tender(a)`
    : `CEJN: ${hits.length} nov(i) tender po tvojim ključnim riječima`;

  await transporter.sendMail({
    from,
    to,
    subject,
    html: buildEmailHtml(hits, isBaseline),
  });
}

// --- glavni tok -------------------------------------------------------------

(async () => {
  const keywords = loadKeywords();
  if (keywords.length === 0) {
    console.error('Nema kljucnih rijeci u src/keywords.json — prekidam.');
    process.exit(1);
  }
  const { firstRun, seen } = loadState();

  console.log(`[cejn-monitor] ${new Date().toISOString()} | firstRun=${firstRun} | dry=${DRY_RUN} | kljucnih rijeci=${keywords.length}`);

  const items = await fetchNewest(MAX_ITEMS);
  console.log(`[cejn-monitor] preuzeto najnovijih tendera: ${items.length}`);

  const hits = [];
  for (const it of items) {
    const m = matchedKeywords(it.title, keywords);
    if (m.length === 0) continue;
    if (seen.has(it.id)) continue; // vec poslato
    it._matched = m;
    hits.push(it);
    seen.add(it.id);
  }

  console.log(`[cejn-monitor] novih pogodaka: ${hits.length}`);
  for (const h of hits) {
    console.log(`   -> [${h.id}] ${h.title}  (${h._matched.join(', ')})  ${TENDER_VIEW + h.id}`);
  }

  if (hits.length > 0) {
    if (DRY_RUN) {
      console.log('[cejn-monitor] DRY RUN — email se NE salje.');
    } else {
      await sendEmail(hits, firstRun);
      console.log(`[cejn-monitor] email poslat (${hits.length}).`);
    }
  }

  // U dry-run rezimu ne diramo stanje, da bi ponovni test opet pokazao pogotke.
  if (!DRY_RUN) {
    saveState(seen);
    console.log('[cejn-monitor] stanje sacuvano.');
  }
})().catch((err) => {
  console.error('[cejn-monitor] GRESKA:', err.message);
  process.exit(1);
});
