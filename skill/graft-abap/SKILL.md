---
name: graft-abap
description: "Code-Orientierung und tokensparendes Lesen in einem lokalen abapGit-Export mit den graft_*-Werkzeugen: wer ruft was, wo steht ein Symbol, wie funktioniert eine Methode, welche Aufrufe sind offen. Nutzen bei „wie funktioniert X\", „was steht in Klasse Y\", „wer ruft X auf\", „wo wird X verwendet\", „Auswirkung einer Änderung\", „wie hängt X mit Y zusammen\" und vor dem Lesen großer ABAP-Klassen. Auch bei „graft\", „Graph\", „Aufrufkette\" oder /graft-abap."
---

# Graft-ABAP: Orientierung im Export

Graft analysiert **nur** den lokal konfigurierten abapGit-Export (`repository` in der Graft-Konfiguration).
Maßgeblich bleibt das SAP-System: Aussagen zum Systemstand über den SAP-Zugriff des Projekts prüfen (z. B. ein ADT-MCP). Fehlende Aufrufer beweisen nichts.

## Reihenfolge (spart Tokens)

1. **Überblick (Richtwert ~450 Tokens Antwortumfang):** `graft_trace_calls` mit `evidence=false`. Wer ruft wen, auf welcher Tiefe.
2. **Nur die interessante Kette (Richtwert ~2.000 Tokens Antwortumfang):** `evidence_targets=["KLASSE=>METHODE"]`, dazu `exit_sources=[]` (keine Abbruchblöcke) oder `exit_sources=["KLASSE=>METHODE", …]` (nur diese).
3. **Gezielt nachlesen:** die gefundene Methode bzw. den Zeilenbereich lesen – im Export per `Read`, für den Systemstand über den SAP-Zugriff.

Den vollen Belegmodus ohne Filter meiden: Er ist länger als die Methodenrümpfe, die er erklärt.

Die Richtwerte sind grobe Angaben zum Umfang einer einzelnen Antwort, keine Tokenizer-Zählung und keine Aussage über die Gesamtersparnis einer Aufgabe.

## Lesen mit Graft (vor `Grep` + `Read`)

Graft ist nicht nur zum Finden da. Für ABAP im Export zuerst diese beiden, erst danach `Read` auf Zeilenbereiche:

- **„Wie funktioniert X?" → `graft_find_code`** mit einer Frage in Klartext, `in:"src/<unterordner>"` zum Eingrenzen, `limit:3`. Liefert in einem Aufruf die Methode mit Signatur, Zeilenbereich und Quelltext, dazu meist den passenden Test und den Konsumenten. Standard sind Ausschnitte; auch `full:true` garantiert keinen vollständigen Rumpf – höchstens 80 Quelltextzeilen je Treffer. Endet ein Treffer mit „+n more lines", die fehlenden Zeilen gezielt nachlesen. Ausschnitte genügen für die Orientierung, aber nicht generell, um Verhalten und Fehlerpfade zu beurteilen – vor einer Änderung oder einer Aussage über das Verhalten den ganzen Rumpf lesen.
- **„Was steht in der Datei?" → `graft_file_api`**: alle Klassen und Methoden mit Signatur und Zeilenbereich.

Was Graft dabei spart und was nicht: Quelltext kostet über Graft so viel wie über `Read` (nur die Zeilennummern entfallen). Die Ersparnis kommt vom Weglassen des Rests und von weniger Runden; gegenüber `Grep` + gezieltem `Read` kann ein Lauf auch kostenneutral ausgehen. Nicht abgedeckt: Doku (`.md`), Tabelleninhalte, SAP-Standard – dort `Read`/`Grep` bzw. der SAP-Zugriff.

Werkzeuge laden: die exakten, vom Client angezeigten Werkzeugnamen verwenden (Liste der verfügbaren bzw. aufgeschobenen Werkzeuge), keinen Präfix raten. Heißt der MCP-Server `graft-abap`, lauten sie `mcp__graft-abap__graft_*`, z. B. `ToolSearch` mit `select:mcp__graft-abap__graft_find_code,mcp__graft-abap__graft_file_api,mcp__graft-abap__graft_trace_calls,mcp__graft-abap__graft_find_all`.

Jede Graft-Nutzung ausdrücklich nennen – im Chat („per Graft ermittelt …"), in Plänen als Schritt mit „[Graft]"; ebenso sagen, wenn etwas nicht aus Graft stammt.

## Werkzeuge

| Werkzeug | Wofür |
|---|---|
| `graft_trace_calls` | Aufrufer (`direction:"in"`, Standard) oder Ziele (`"out"`); `depth` als Zahl, `"2"` oder `"all"`; die tatsächliche Tiefe steht im Kopf der Antwort |
| `graft_find_code` | „Wie funktioniert X", ranglistige Treffer mit Quelltext – erspart oft `Grep` + `Read`; `full:true` für längere Ausschnitte (höchstens 80 Zeilen je Treffer), `in` und `limit` zum Eingrenzen |
| `graft_find_all` | jede Fundstelle eines Musters, wenn Vollständigkeit zählt |
| `graft_file_api` | alle Signaturen einer Datei mit Zeilenbereichen – die Landkarte vor jedem `Read` |
| `graft_repo_map` | Einstieg in unbekannte Bereiche |
| `graft_unresolved_calls` | Aufrufe ohne Ziel im Export, z. B. `query:"RPTIME00"`; Filter nach `reason`, `source`, `target_kind` |
| `graft_diagnostics` | Analysehinweise nach Kategorie, z. B. `kind:"unresolved_receiver"` |
| `graft_check_freshness` | Version und ob der Graph zum Export passt |

Bei `graft_unresolved_calls` und `graft_diagnostics` die `revision` von Seite 1 in Folgeseiten mitgeben.

## Belege richtig lesen

- **`possibly infeasible`:** Ein weggelassener Parameter mit Default widerspricht einer Bedingung am Ziel. Der Hinweis gilt nur für die genannten Aufrufstellen und Prämissen – nicht pauschal für die ganze Kette oder Methode; andere Aufrufstellen derselben Kette können laufen.
- **`Earlier exits`:** `RETURN`/`EXIT`/`CHECK` vor der Aufrufstelle. Sie belegen nicht, dass der Abbruch greift.
- **`Assigned via call output` / `Earlier assignment candidates`:** Quelltextreihenfolge, keine berechneten Werte.
- **`Stable evidence ID`:** bleibt bei identischen Quellenbelegen und unverändertem Kennungsverfahren gleich, auch über Filter hinweg; Änderungen an Pfad, Zeilenposition oder Quelltext können sie verändern. Die kurzen `S`/`E`/`A`-Nummern wechseln ohnehin.
- **Diagnose statt Kante:** `SUBMIT`, `CALL TRANSACTION` ohne Ziel, dynamische Aufrufe und SAP-Standard erscheinen als offene Referenz, nie als erfundene Kante.

## Aktualität

- `graph check: OK` heißt nur: Graph passt zum Export. Über das SAP-System sagt es nichts.
- Nach einem neuen Export frischt Graft bei der nächsten Abfrage selbst auf. Die Grafik dagegen neu erzeugen: im Installationsordner von Graft-ABAP `node pilot/run.mjs --config <Konfiguration> viz`; Ergebnis unter `<graphDirectory>/visual/`.
- Meldet eine Abfrage `not verified current` oder `ANALYSIS INCOMPLETE`, zuerst die ausgegebene Ursache lesen – ein abgebrochener Export ist nur eine der möglichen Ursachen. Ist es ein Exportproblem: den Export kontrolliert wiederholen (Produzentenvertrag in `INSTALL-ABAP.md`), kein Manifest von Hand auf `ready` setzen.

## Nie

- Graft-Ergebnisse als Systemstand ausgeben; „im Export nicht vorhanden" ist nicht „in SAP nicht vorhanden"
- Dateien oder Graphen im Exportordner ablegen (der Exportproduzent ersetzt ihn)
- Aus fehlenden Aufrufern auf ungenutzten Code schließen

Weitere Doku im Installationsordner von Graft-ABAP: `INSTALL-ABAP.md`, `ABAP-DIAGNOSTICS.md`, `ABAP-RETURN-CHAINS.md`, `ABAP-OBJECT-EXPRESSIONS.md`, `ABAP-EXECUTION.md`.
