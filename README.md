# CEJN Monitor

Servis koji **prati nove objave javnih nabavki na zvaničnom CEJN portalu** (`cejn.gov.me`)
i šalje **email** kada se pojavi tender čiji naslov sadrži tvoje ključne riječi
(podrazumijevano: *rasvjeta, osvjetljenje, visoka/niska struja* i sinonimi).

Radi besplatno na **GitHub Actions** (na svakih ~20 min, 24/7, i kad ti je računar ugašen).

---

## Kako radi

1. Poziva javni endpoint portala:
   `POST https://cejn.gov.me/api/cadocuments/GetTenders` — vraća najnovije objavljene
   tendere (sortirane po datumu). Radi **bez logina**.
2. Filtrira naslove po ključnim riječima iz [`src/keywords.json`](src/keywords.json)
   (bez razlike na velika/mala slova i dijakritike: `š→s, č/ć→c, ž→z, đ→dj`).
3. Pamti već poslate tendere u `state/seen.json` da **ne stižu duplikati**.
4. Šalje uredan HTML email preko **Brevo SMTP-a** (besplatno 300 mejlova/dan), sa
   linkom na svaki oglas (`https://cejn.gov.me/tenders/view-tender/{id}`).

## Uređivanje ključnih riječi

Otvori [`src/keywords.json`](src/keywords.json) i mijenjaj listu. Savjet: koristi **korijen**
riječi da uhvatiš sve padeže — `rasvjet` hvata *rasvjeta / rasvjete / rasvjetu / rasvjetna…*

> Napomena: filtriranje ide po **naslovu** tendera (to je jedino polje koje portal vraća u
> listi). Tenderi kod kojih je rasvjeta/struja samo u opisu ili stavkama, a ne u naslovu,
> mogu promaći — za većinu je ključna riječ ipak u naslovu.

---

## 1) Napravi Brevo nalog i SMTP ključ (jednokratno)

Brevo (ex-Sendinblue) je besplatan do **300 mejlova/dan** i šalje na bilo koju adresu.

1. Registruj se na https://www.brevo.com
2. **Verifikuj pošiljaoca**: *Senders, Domains & IPs → Senders → Add a sender* →
   upiši email s kog želiš da šalješ → klikni potvrdni link koji ti stigne na taj mejl.
3. Uzmi SMTP kredencijale: *SMTP & API → SMTP*:
   - **Login** (to je `SMTP_USER`)
   - klikni **Generate a new SMTP key** → dobiješ ključ (to je `SMTP_PASS`)

## 2) Lokalni test (opciono, ali preporučeno)

```powershell
cd C:\Users\Korisnik\cejn-monitor
copy .env.example .env       # pa u .env upiši SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_TO
npm install
npm run dry                  # samo ispis, bez slanja
npm start                    # stvarno slanje (čita .env automatski)
```

> `MAIL_FROM` mora biti **verifikovani** pošiljalac iz koraka 1 (npr. `CEJN Monitor <ime@domen>`),
> inače Brevo odbija poruku.

## 3) Postavi na GitHub (besplatno, 24/7)

1. Napravi **privatni** repo na GitHub-u (npr. `cejn-monitor`).
2. Push-uj ovaj folder:
   ```powershell
   cd C:\Users\Korisnik\cejn-monitor
   git init
   git add .
   git commit -m "CEJN monitor"
   git branch -M main
   git remote add origin https://github.com/<tvoj-korisnik>/cejn-monitor.git
   git push -u origin main
   ```
3. Na GitHub-u: **Settings → Secrets and variables → Actions → New repository secret**,
   dodaj četiri tajne:
   - `SMTP_USER` = Brevo SMTP login
   - `SMTP_PASS` = Brevo SMTP ključ
   - `MAIL_FROM` = verifikovani pošiljalac (npr. `CEJN Monitor <ime@domen>`)
   - `MAIL_TO` = adresa na koju stižu obavještenja
4. Otvori tab **Actions** → workflow „CEJN tender monitor" → **Run workflow** (prvo ručno pokretanje).
   Nakon toga radi automatski svakih 20 min.

> Prvo pokretanje šalje jedan „baseline" mejl sa trenutno otvorenim relevantnim tenderima,
> a poslije stiže mejl samo kad se pojavi **nova** objava.

---

## Podešavanja

| Env / fajl | Značenje |
|---|---|
| `SMTP_USER` | Brevo SMTP login |
| `SMTP_PASS` | Brevo SMTP ključ |
| `MAIL_FROM` | verifikovani pošiljalac (npr. `CEJN Monitor <ime@domen>`) |
| `MAIL_TO` | primalac (bilo koja adresa) |
| `SMTP_HOST` | (opciono) default `smtp-relay.brevo.com` |
| `SMTP_PORT` | (opciono) default `587` |
| `MAX_ITEMS` | koliko najnovijih tendera pregledati (default `300`) |
| `src/keywords.json` | lista ključnih riječi |
| `.github/workflows/monitor.yml` | raspored (`cron: */20 * * * *`) |

## Cijena

Besplatno. GitHub Actions daje dovoljno besplatnih minuta za ovako kratke provjere;
CEJN endpoint je javan.

## Struktura

```
cejn-monitor/
├─ src/monitor.js        # glavni skript (fetch → filter → dedupe → email)
├─ src/keywords.json     # ključne riječi
├─ state/seen.json       # već poslati tenderi (pravi se automatski)
├─ tools/discover.js     # jednokratni alat kojim je otkriven API (nije dio servisa)
└─ .github/workflows/monitor.yml
```
