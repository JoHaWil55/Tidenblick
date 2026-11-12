# Tidenblick Nordsee

Tidenkurven, Hoch- und Niedrigwasser sowie Wasserstandsvorhersagen für Pegel an der deutschen Nordseeküste – auf Basis der offenen Daten des [BSH](https://www.bsh.de/). Zusätzlich ein Rechner für die Passage von Wattenhöhen (Wattsegeln).

Die App ist eine statische Webseite ohne Build-Schritt und ohne Backend: `index.html` plus JavaScript und CSS, direkt ausgeliefert z. B. über GitHub Pages.

## Funktionen

- **Tidenkurven-Chart** (D3): astronomische Vorausberechnung, amtliche Vorhersage, Messwerte, Nacht-Shading, MHW/MNW; Zeiträume 24 Std. / 3 Tage / 7 Tage
- **Hoch- und Niedrigwasser-Tabelle** mit amtlicher Vorhersage, MOS-Läufen und Abweichungen
- **Wattenhoch-Passage**: berechnet aus Kartenhöhe, Tiefgang und Zeitversatz die Zeitfenster, in denen ein Wattenhoch mit dem eigenen Boot passierbar ist – inkl. fertiger Fahrwasser-Presets (`presets.js`) mit Quellenangaben und Verfallswarnung für veraltete Lotungen
- **80+ Pegel** von Ems bis Sylt mit Karte (Leaflet), Suche, Favoriten und „Pegel in meiner Nähe" (Geolocation)
- **Bezugshöhen** umschaltbar: PNP / NHN / SKN
- **Sonne & Mond**: Auf-/Untergänge, Mondphase, Spring-/Nipptiden-Hinweis
- **Offline-Fähig**: installierbare PWA (Service Worker, App-Shell offline, Kartekacheln begrenzt im Cache); zuletzt geladene BSH-Daten werden bei Funkloch mit „Daten vom …"-Hinweis weiter angezeigt
- **Teilbare Links**: Pegel, Bezugshöhe, Zeitraum und Wattenhoch-Einstellungen stehen im URL-Hash
- Hell-/Dunkelmodus, vollständige Tastaturbedienung der Pegelliste und Segmente

## Datenquellen & Lizenzen

- Wasserstands- und Gezeitendaten: [BSH, Open Data](https://gdi.bsh.de/) (API: `gdi.bsh.de`), Lizenz CC BY 4.0 – maßgeblich sind die amtlichen Veröffentlichungen auf [wasserstand.bsh.de](https://wasserstand.bsh.de/) und [gezeiten.bsh.de](https://gezeiten.bsh.de/)
- Kartekacheln: Esri World Light/Dark Gray Canvas (Attribution wie in der Karte angezeigt)

Die App ist eine Planungshilfe **ohne Gewähr**. Wattenhöhen und Fahrwasser ändern sich laufend; maßgeblich sind aktuelle amtliche Seekarten, Peilungen und Bekanntmachungen. Die Verantwortung liegt bei der Schiffsführung.

## Entwicklung

Kein Build, keine Abhängigkeiten zum Installieren – Dateien editieren und statisch ausliefern:

```sh
python3 -m http.server 8000
# http://localhost:8000
```

Struktur:

| Datei | Inhalt |
|---|---|
| `index.html` | Oberfläche, lädt alle Skripte |
| `app.js` | Anwendungslogik: Datenabruf, Chart, Tabellen, Wattenhoch-Rechner |
| `stations.js` | Pegelliste (ID, Name, Koordinaten, Gebiet) |
| `presets.js` | Bekannte Wattfahrwasser mit Bezugspegel und Zeitversatz |
| `styles.css`, `fonts.css` | Gestaltung, lokal ausgelieferte Schriften |
| `vendor/` | d3, Leaflet, SunCalc (lokal gehostet, siehe Lizenzen unten) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Progressive Web App |

Der Service Worker wird bei Änderungen durch Anheben von `VERSION` in `sw.js` aktualisiert.

## Komponenten-Lizenzen

| Komponente | Lizenz |
|---|---|
| [d3](https://github.com/d3/d3) | ISC |
| [Leaflet](https://github.com/Leaflet/Leaflet) | BSD-2-Clause |
| [SunCalc](https://github.com/mourner/suncalc) | BSD-2-Clause |
| [Satoshi](https://www.fontshare.com/fonts/satoshi) | ITF Free Font License |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | SIL OFL 1.1 |
