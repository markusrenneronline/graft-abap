# Graft-ABAP

Code-Orientierung für ABAP: Graft-ABAP liest einen lokalen abapGit-Export, baut daraus einen Graphen (Klassen, Methoden, Aufrufe, offene Referenzen) und stellt ihn Coding-Agenten wie Claude Code über einen MCP-Server zur Verfügung. Fragen wie „wer ruft diese Methode", „wo steht das Symbol" oder „welche Aufrufe haben kein Ziel im Export" lassen sich damit beantworten, ohne ganze Klassen zu lesen.

Graft-ABAP ist ein Pilot auf Basis von [Graft](https://github.com/trailhq/Graft) 0.18.0 (MIT-Lizenz, siehe [LICENSE](LICENSE) und [CREDITS.md](CREDITS.md)). Die Beschreibung des Ausgangsprojekts liegt unverändert in [README-GRAFT.md](README-GRAFT.md).

## Wichtig vorab

- **Nicht** `npm install -g @nanonets/graft` und **nicht** `graft init` aus README-GRAFT.md verwenden: Das npm-Paket enthält die ABAP-Erweiterung nicht, und `graft init` verdrahtet Hooks und Agenten-Konfigurationen automatisch. Graft-ABAP wird aus diesem Repository gebaut und über `pilot/run.mjs` gestartet; es ändert keine Client-Konfiguration von selbst.
- Die Analyse ist statisch und lexikalisch. Sie belegt Quelltextstellen, keine Laufzeit: Ein fehlender Aufrufer beweist keinen ungenutzten Code, „im Export nicht vorhanden" heißt nicht „in SAP nicht vorhanden". Maßgeblich bleibt das SAP-System.
- Kein SAP-Zugriff nötig, kein Sync. Der Starter schaltet LLM- und Telemetrie-Aufrufe für seinen Prozess ab.
- Die Benchmark-Zahlen in README-GRAFT.md stammen vom Ausgangsprojekt und anderen Sprachen. Für ABAP gibt es keine gemessene Zeit- oder Tokenersparnis. Erfahrung aus dem Pilot (Schätzung, keine Messung): Quelltext kostet über Graft so viel wie direktes Lesen; gespart wird durch Weglassen des Rests und weniger Suchrunden, ein Lauf kann auch kostenneutral ausgehen. Wie sich vollständige Aufgaben mit und ohne Graft sauber vergleichen lassen, beschreibt [ABAP-BENEFIT-EVALUATION.md](ABAP-BENEFIT-EVALUATION.md).

## Voraussetzungen

- Node.js ab 22.12.0 und Git. Geprüft auf Windows x64 mit Node 26; andere Plattformen brauchen ihre eigene Prüfung.
- Ein abapGit-Export mit `src/` (ABAP-/abapGit-Dateien), getrennt von diesem Ordner abgelegt. Ziel-Syntax der Analyse: ABAP 7.50.

## Einstieg

1. **Installieren und bauen** – [INSTALL-ABAP.md](INSTALL-ABAP.md), Abschnitt 2: `npm ci --ignore-scripts --no-audit --no-fund`, `npm run build`, `node scripts/smoke-abap-install.mjs` (erwartet `ok: true`).
2. **Eigenen Export verbinden** – Abschnitt 3: eine kleine JSON-Konfiguration (`repository`, `graphDirectory`, `abapVersion`), dann `node pilot/run.mjs --config <Konfiguration> build` und `check`. Abschnitt 4 zeigt den MCP-Eintrag für den Client.
3. **Skill für Claude Code kopieren** – Abschnitt 5: `skill/graft-abap/` enthält die Arbeitsregeln (Reihenfolge, Filter, Belege lesen).

Updates: `git pull`, danach Schritt 1 wiederholen und den Skill neu kopieren. Der Stand steht im Tag (`git describe --tags`).

## Werkzeuge des MCP-Servers

| Werkzeug | Wofür |
|---|---|
| `graft_trace_calls` | Aufrufer oder Ziele einer Methode, mit Tiefe und wählbaren Belegketten |
| `graft_find_code` | „Wie funktioniert X" – ranglistige Treffer mit Quelltextausschnitt |
| `graft_find_all` | jede Fundstelle eines Musters, wenn Vollständigkeit zählt |
| `graft_file_api` | alle Signaturen einer Datei mit Zeilenbereichen |
| `graft_repo_map` | Überblick über unbekannte Bereiche |
| `graft_unresolved_calls` | Aufrufe ohne Ziel im Export (SAP-Standard, nicht exportierte Objekte, dynamische Aufrufe) |
| `graft_diagnostics` | Analysehinweise nach Kategorie |
| `graft_check_freshness` | Version und ob der Graph zum Export passt |

## Weitere Doku

- [ABAP-EXECUTION.md](ABAP-EXECUTION.md) – ABAP-Aufrufe: Start, Registrierung und Callback
- [ABAP-RETURN-CHAINS.md](ABAP-RETURN-CHAINS.md) – Rückgabetypen in Methodenketten, Belege und bewusste Grenzen
- [ABAP-OBJECT-EXPRESSIONS.md](ABAP-OBJECT-EXPRESSIONS.md) – `NEW` und `CAST` im Graphen, Konstruktoren
- [ABAP-DIAGNOSTICS.md](ABAP-DIAGNOSTICS.md) – aufgezeichnete Analysediagnosen (englisch)
- [ABAP-BENEFIT-EVALUATION.md](ABAP-BENEFIT-EVALUATION.md) – Verfahren zum Vergleich vollständiger Aufgaben mit und ohne Graft
- [SECURITY.md](SECURITY.md), [TELEMETRY.md](TELEMETRY.md) – Angaben des Ausgangsprojekts

## Stand

Pilot, kein npm-Release (`package.json` ist `private`). Die Tests (`npm run test:abap`) arbeiten mit synthetischen ABAP-Beispielen; eigene Akzeptanzfälle für das eigene Paket bleiben nötig. Rückmeldungen bitte an den Herausgeber dieses Repositories.
