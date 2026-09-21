# Graft-ABAP: Installation aus dem Quellcodepaket

Das Paket enthält Werkzeugquellen und Tests, keine SAP-Quellen, persönlichen Konfigurationen, Abhängigkeiten oder vorberechneten Graphen. ZIP und zugehörige Manifestdatei zusammen aufbewahren. Node.js ab 22.12.0 ist erforderlich. Der lokale Pilot wurde auf Windows x64 mit Node 26.7.0 geprüft; weitere Rechner und Plattformen benötigen ihre eigene Prüfung.

## Variante Git (Auslieferungsrepo)

Wer Zugriff auf das Auslieferungsrepo hat, klont es, statt das ZIP zu entpacken, und macht bei Abschnitt 2 weiter. Die Manifestprüfung aus Abschnitt 1 gilt nur für das ZIP; beim Clone sichert Git die Inhalte. Das Repo enthält `.gitattributes` mit `* -text`, damit Zeilenenden unverändert bleiben.

```powershell
git clone <URL des Auslieferungsrepos> C:/dev/graft-abap
```

Update: `git pull`, danach Abschnitt 2 wiederholen (`npm ci`, Build, Installationstest) und den Skill neu kopieren (Abschnitt 5). Der Stand ist am Tag erkennbar (`git describe --tags`), er entspricht der Pilotversion in `pilot/run.mjs`.

## 1. Entpackten Stand prüfen

Das ZIP in einen neuen Ordner entpacken. Es enthält `graft-abap/`. Vor Installation oder Konfiguration in diesen Unterordner wechseln und die Dateiintegrität prüfen:

```powershell
node scripts/verify-abap-package.mjs --manifest /pfad/zum/paket.manifest.json --archive /pfad/zum/paket.zip
```

Die Pfade durch die tatsächlichen Dateinamen ersetzen. Erwartet wird `ok: true`. Die Prüfung vergleicht alle enthaltenen Dateien und die ZIP-Prüfsumme mit dem Manifest. Sie erkennt Änderungen und unerwartete Dateien; sie ist keine Signatur des Herausgebers. Sie ist für den frisch entpackten Stand vorgesehen, bevor `node_modules`, `dist` oder lokale Konfigurationen erzeugt werden.

## 2. Abhängigkeiten und Build

```powershell
node --version
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node scripts/smoke-abap-install.mjs
```

`npm ci` benötigt Paketquellen oder einen gefüllten lokalen npm-Cache. Für einen bewussten Offline-Test `--offline` hinzufügen. Der Build benötigt die Entwicklungsabhängigkeiten; kein `--omit=dev` verwenden. Installationsskripte bleiben deaktiviert, der Build wird ausdrücklich gestartet.

Der Installationstest erzeugt einen kleinen synthetischen ABAP-Export im temporären Verzeichnis, baut dessen Graphen und prüft Diagnose sowie MCP über einen separaten Prozess. Dabei werden weder bestehende Konfigurationen noch ein eigener SAP-Export verändert. Erwartet: `ok: true`, acht Werkzeuge, neun Trace-Parameter und keine Diagnosewarnung. Der temporäre Testbestand wird anschließend entfernt.

## 3. Eigenen ABAP-Export verbinden

Werkzeug und Export getrennt ablegen. Der Export muss ein `src/` mit ABAP-/abapGit-Dateien enthalten. Eine Kopie von `pilot/config.example.json` als eigene JSON-Konfiguration speichern:

```json
{
  "repository": "C:/dev/mein-abap-export",
  "graphDirectory": "graph",
  "abapVersion": "7.50"
}
```

`repository` muss absolut sein. Relative Pfade für `graphDirectory` und optional `sourceState` beziehen sich auf den Ordner der Konfigurationsdatei. Der Graph muss außerhalb des Exports bleiben. Eine vorhandene Konfiguration nicht ersetzen.

```powershell
node pilot/run.mjs --config C:/dev/graft-config/config.json build
node pilot/run.mjs --config C:/dev/graft-config/config.json check
node pilot/run.mjs --config C:/dev/graft-config/config.json map
node pilot/doctor.mjs --config C:/dev/graft-config/config.json
```

Ohne `--config` verwendet der Starter wie bisher `pilot/config.json`. Bei automatisch ersetzten Exporten einen Produzentenvertrag über `sourceState` einrichten: Ein Produzent muss vor dem Austausch `beginExport` und erst nach vollständiger Prüfung `completeExport` aus `dist/graph/source-state.js` verwenden. Ein Zustand `updating` bleibt nach einem Abbruch gesperrt, bis der Export kontrolliert wiederhergestellt ist. Ohne diesen Vertrag meldet die Diagnose eine Warnung; ein ruhender unvollständiger Export lässt sich sonst nicht sicher von einem absichtlich kleinen Export unterscheiden.

`viz` erzeugt bei eigener Konfiguration die Ansicht unter `<graphDirectory>/visual/`. Die Standardkonfiguration behält ihren bisherigen Ort `pilot/visual/`. So überschreiben getrennte Konfigurationen mit eigenen Graphverzeichnissen nicht dieselbe Ansicht.

Der Starter arbeitet statisch auf lokalen Quellen, deaktiviert LLM-/Telemetry-Aufrufe für seinen Prozess und führt keinen SAP-Sync aus. Ein Graph kann offene Referenzen enthalten, wenn Ziele nicht exportiert oder statisch nicht auflösbar sind. Das ist kein Beweis, dass sie in SAP fehlen.

## 4. MCP verbinden

Den folgenden Eintrag an den eigenen Rechner anpassen und in die passende MCP-Konfiguration des Clients aufnehmen. Andere Servereinträge erhalten:

```json
{
  "mcpServers": {
    "graft-abap": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["C:/dev/graft-abap/pilot/run.mjs", "--config", "C:/dev/graft-config/config.json", "mcp"]
    }
  }
}
```

Neu verbinden und `graft_check_freshness` sowie eine bekannte Methode über `graft_trace_calls` prüfen. Clientkonfigurationen werden durch das Paket nicht automatisch geändert. SAP-Zugriff ist für diese Installation nicht erforderlich; aktuelle Systemaussagen benötigen weiterhin einen gesonderten SAP-Abgleich.

## 5. Skill für Claude Code installieren

Der Ordner `skill/graft-abap/` enthält die Arbeitsregeln für die `graft_*`-Werkzeuge (Reihenfolge, Filter, Belege lesen). Ohne verbundenen MCP-Server (Abschnitt 4) nützt er nichts. Den Ordner kopieren – je Projekt nach `<Projekt>/.claude/skills/graft-abap/` oder für alle Projekte nach `~/.claude/skills/graft-abap/`:

```powershell
Copy-Item -Recurse -Force C:/dev/graft-abap/skill/graft-abap C:/dev/mein-projekt/.claude/skills/
```

Nach einem Update erneut kopieren. Projektspezifische Ergänzungen (Name des SAP-Zugriffs, Exportproduzent) gehören in die `CLAUDE.md` des Projekts, nicht in die Kopie.

## Umfang der Tests

`npm run test:abap` prüft die ABAP-Fälle. `npm test` prüft die gesamte Suite und benötigt zusätzlich Git für temporäre Testrepositories. HRCORE-spezifische Prüfdaten, historische Pilotberichte und projektspezifische Installationshelfer sind nicht im allgemeinen Paket. Das Paket erzeugt keine neue Abnahme für beliebige SAP-Projekte; eigene Akzeptanzfälle bleiben erforderlich.
