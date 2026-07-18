PROTOCOL FIT PWA 2.0
====================

Applicazione personale basata esclusivamente sulla scheda fornita.
Non richiede Mac, Xcode, TestFlight, account o abbonamenti.

FUNZIONI PRINCIPALI
- Scheda completa di 14 settimane, invariata rispetto alla versione 1.1.
- Giorno 04 Fase 01: spalle + circuito addome.
- Giorno 05 Fase 01: unica opzione con curl EZ su panca 45° e tricipiti singolo con straps.
- Set Autopilot: peso e ripetizioni precompilati dallo storico.
- Logger a un tap, RIR rapido, timer e undo.
- Check-in readiness locale, senza alterare la scheda.
- Analytics: volume, serie equivalenti per muscolo, e1RM, PR e heat map.
- Misure corporee, livelli e badge.
- IndexedDB con migrazione automatica dei dati della versione 1.x.
- Backup JSON ed esportazione CSV.
- Funzionamento offline tramite service worker.

INSTALLAZIONE SU GITHUB PAGES
1. Estrai lo ZIP.
2. Carica TUTTI i file nella radice del repository GitHub esistente.
3. Non caricare la cartella esterna: index.html deve essere visibile subito nella home del repository.
4. Attendi la pubblicazione di GitHub Pages.
5. Apri il link *.github.io con Safari.
6. Condividi > Aggiungi alla schermata Home > Apri come app web.

AGGIORNAMENTO DA V1.1
- Fai prima un backup dalla vecchia app.
- Sostituisci tutti i file su GitHub.
- Non cancellare i dati di Safari e non rimuovere subito l’icona.
- Apri il link in Safari, ricarica, chiudi l’app dalla schermata multitasking e riaprila.
- Al primo avvio, storico, workout in corso e impostazioni vengono migrati in IndexedDB.

LIMITI PWA
- Apple Health, Health Connect e app native per smartwatch non sono accessibili direttamente.
- Il timer usa timestamp reali, ma iOS può sospendere suono e vibrazione quando l’app è chiusa o lo schermo è bloccato.
