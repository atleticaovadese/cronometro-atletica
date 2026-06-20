# Atletica · Cronometro Velocità

PWA per il cronometraggio della velocità in atletica.

## Cosa fa
**Partenza (a due tempi, controllata dall'allenatore):**
1. Premi **"Ai vostri posti"** → l'app pronuncia il comando.
2. Quando gli atleti sono **fermi sui blocchi**, premi **"Atleti fermi → Pronti + sparo"**.
3. L'app dice "Pronti", poi dopo un intervallo **randomizzato** spara e parte il
   cronometro **al centesimo** (t0 agganciato all'istante esatto dello sparo).

**Arrivo:**
- **Manuale**: pulsante 🏁 (tap di controllo).
- **Automatico da camera** (spunta "Arrivo automatico"): la fotocamera riconosce fino a
  **6 atleti** (MoveNet MultiPose) e registra **tempo + corsia** quando il busto taglia
  il traguardo. Il tempo è **interpolato tra i fotogrammi** per migliorare la precisione.

**Atleti & risultati:**
- 6 corsie con nome atleta. Risultati ordinati per tempo, **salvataggio** e **export CSV**.

**Storico & statistiche (scheda 📊):**
- Tutte le run salvate (con cancellazione singola o totale).
- Per ogni atleta+distanza: **miglior tempo**, ultimo tempo, **andamento** (▼ migliorato /
  ▲ peggiorato) e **mini-grafico di progressione**.

## Come usarlo
### Sul PC (logica e partenza)
Doppio clic su `index.html`. Funzionano voce e cronometro.
*(La fotocamera richiede HTTPS → vedi sotto.)*

### Sull'iPhone (con fotocamera)
Serve **HTTPS**. Pubblica su **GitHub Pages** (guida sotto), apri in Safari, "Aggiungi a Home".

> ⚠️ La fotocamera e il modello di rilevamento richiedono **connessione internet la
> prima volta** (il modello viene scaricato). Dopo, l'interfaccia funziona anche offline.

## Uso della fotocamera (vista laterale)
1. Telefono su **cavalletto**, di lato, **perpendicolare** al traguardo, ben fermo.
2. Scheda **Camera** → "Avvia fotocamera".
3. **Calibra**:
   - *Linea traguardo*: sposta finché la riga rossa è sul traguardo reale.
   - *Bordo vicino / lontano*: racchiudi con le righe azzurre la zona delle corsie.
   - *Numero corsie* e *Corsia 1 in alto*: per assegnare bene le corsie.
4. Scheda **Atleti**: imposta il **verso di corsa** (da che lato arrivano).
5. Scheda **Partenza**: spunta **"Arrivo automatico da camera"** e avvia la sequenza.

> Nota onesta: in PWA il browser di solito cattura a 30–60 fps → precisione ~1–2 centesimi
> (ottima per allenamento, non "ufficiale"). L'assegnazione corsia su vista laterale è
> approssimata dalla posizione verticale; calibra bene bordo vicino/lontano. Da testare e
> tarare sul campo: angolo, luce e occlusioni tra atleti incidono.

## ✅ Checklist test camera (lunedì)
1. App aperta in **Safari** sull'iPhone via indirizzo **https** (GitHub Pages).
2. Scheda **Camera** → "Avvia fotocamera". Guarda la **diagnostica**:
   - **FPS**: quanti te ne dà davvero il telefono? (30? 60?) → decide la precisione possibile.
   - **Atleti**: muoviti davanti alla camera, deve contare le persone rilevate.
3. **Calibra** (traguardo rosso + banda corsie azzurra) e ricarica la pagina:
   la calibrazione deve **restare salvata**.
4. Premi **⏺ Registra clip**, fai passare qualcuno sul traguardo, **⏹ Stop & salva**:
   scarichi un video da riguardare insieme per tarare la rilevazione.
5. Prova un arrivo con **"Arrivo automatico da camera"** attivo (scheda Partenza) e vedi
   se compaiono tempo + corsia.

> Annota: **FPS reali**, se conta bene gli atleti, e mandami una **clip** registrata:
> con quei dati taro la rilevazione sui numeri veri.

## Pubblicare su GitHub Pages (gratis, HTTPS)
1. Account su https://github.com → nuovo repository (es. `cronometro-atletica`).
2. Carica il contenuto della cartella `atletica-app`.
3. Settings → **Pages** → Source: `main` / root → Save.
4. Dopo ~1 min: `https://TUONOME.github.io/cronometro-atletica/` → aprilo in Safari.

## Struttura
```
atletica-app/
├── index.html              # 3 schede: Atleti · Partenza · Camera
├── css/styles.css
├── js/state.js             # atleti, run, risultati, CSV (localStorage)
├── js/audio.js             # partenza a 2 tempi + sparo
├── js/camera.js            # camera + MoveNet + rilevamento arrivo
├── js/app.js               # orchestrazione UI
├── sw.js · manifest.webmanifest · icons/icon.svg
```

## Roadmap residua / idee
- Taratura fps reali sul tuo iPhone; eventuale Tappa 2 nativa (120/240 fps) per il centesimo "vero".
- Miglior assegnazione corsia (prospettiva non lineare), gestione occlusioni.
- Storico per atleta, grafici progressione, vento/condizioni.

Piano completo e studio di fattibilità: `../PIANO_app_atletica.md`.
