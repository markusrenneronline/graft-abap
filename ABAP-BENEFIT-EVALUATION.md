# Graft-ABAP: vollständige Aufgaben vergleichen

`scripts/evaluate-abap-benefit.mjs` wertet aufgezeichnete Durchläufe mit und ohne Graft aus. Es startet keine Modellaufrufe, führt keine Aufgaben aus und schätzt keine Tokens. Die vorhandene Quellenbelegprüfung und kleinere Werkzeugausgaben sind weiterhin getrennte Messgrößen. Ein vorbereitetes Experiment ohne Durchläufe weist keine Ersparnis nach.

## Vergleich vorab festlegen

- Beide Arme erhalten dieselbe Aufgabe, denselben Export, dasselbe genaue Modell samt Einstellungen und dieselben Limits. Baseline: normale Suche und gezielte Dateiabrufe ohne Graft, Graphdateien oder fertige Pilotantworten. Graft: dieselben Möglichkeiten plus Graft, ohne vorgegebene optimale Abfrage.
- Jeder Durchlauf startet in einer frischen Sitzung ohne Vorwissen aus anderen Durchläufen. Auch Projektwissen und automatisch geladene Dokumente kontrollieren. Bewertungen und Referenzantworten bleiben beim unabhängigen Bewerter.
- Aufgaben, Pflichtkriterien und Paarreihenfolge vor dem ersten Lauf festlegen. Reihenfolge zwischen Paaren wechseln; zwei Arme desselben Paars nacheinander ausführen. Wiederholungen sind neue Paare und neue Sitzungen.
- Entwicklungsaufgaben als `development` kennzeichnen; bislang unbenutzte Aufgaben als `held_out`. Kalte und warme Graphen getrennt planen. Die Auswertung vermischt diese Gruppen nicht.
- Zeit umfasst den vollständigen Aufgabenablauf einschließlich Wartezeiten, Fehlversuchen und Wiederholungen bis zur finalen Antwort oder zum Abbruch. Bei kaltem Graphen den dafür benötigten Aufbau einschließen. Einmalige Einrichtungskosten eines warmen Graphen separat protokollieren; das Skript berechnet keine Amortisation.
- Lokale Analyse und Live-SAP-Prüfung in getrennten Experimenten durchführen. Bei Live-SAP gelten dieselben Zugänge und Prüfpflichten für beide Arme. Quellen- und Laufzeitbelege nicht gleichsetzen.

## Quellenstand und Plan

Bei abgeschlossenem, während der Messung ruhendem Export:

```powershell
node scripts/evaluate-abap-benefit.mjs fingerprint C:/dev/mein-abap-export
```

Der Fingerprint umfasst relative Dateinamen und rohe Dateiinhalte aller Dateien unter `src/`, einschließlich XML. Symbolische Verknüpfungen werden abgewiesen. Ohne Zustandsdatei meldet die CLI `sourceState: null`: Der abgeschlossene Exportstatus wurde nicht geprüft.

Bei einem Export mit Produzentenvertrag ab pilot.26 dessen Zustandsdatei mitgeben (benötigt den vorhandenen Build, bei einer frischen Installation zuerst `npm run build`):

```powershell
node scripts/evaluate-abap-benefit.mjs fingerprint C:/dev/mein-abap-export --source-state C:/dev/.graft-exports/mein-abap-export.json
```

Diese Variante verwendet dieselbe Exportprüfung wie die Graphaktualisierung. Sie akzeptiert ausschließlich `ready` mit passenden Dateinamen und Dateiinhalten. Fehlende oder ungültige Zustandsdateien, ein falscher Exportpfad, `updating`, unvollständige Quellen und eine während der Prüfung wechselnde Generation liefern einen Fehler ohne Fingerprint. Der Hash wird aus genau dem geprüften Inventar abgeleitet. Die Ausgabe enthält zusätzlich `sourceState.status` und `sourceState.generation`; bei identischen Quellen bleibt der bisherige Inhaltsfingerprint unverändert.

Vor und nach jedem Durchlauf den Fingerprint und bei geschütztem Export auch die Generation aufzeichnen. Gleiche Inhaltsfingerprints allein beweisen nicht, dass die Quellen während des gesamten Durchlaufs unverändert waren. Eine gewechselte Generation zwischen Anfang und Ende verlangt eine erneute Prüfung des Durchlaufs, auch bei identischem Inhalt. Die Prüfung sperrt den Export nicht; für die Messung weiterhin einen ruhenden Export verwenden. Die Zustandsdatei wird vom Exportproduzenten verwaltet, niemals für einen fehlgeschlagenen Messlauf von Hand auf `ready` setzen.

Planstruktur, zunächst als Entwurf speichern:

```json
{
  "format": 1,
  "id": "mein-abap-vergleich",
  "status": "draft",
  "frozenAt": null,
  "sourceFingerprint": "SHA256_AUS_DER_AUSGABE",
  "sourcePolicy": "producer_verified",
  "modelKey": "Anbieter / exakte Modellrevision / Einstellungen / Limits",
  "protocol": "Gleiche Aufgaben und Quellen; frische Sitzungen; vollständige Aufgabenzähler. Hier auch Werkzeugversionen, Kontextvorgaben, Bewertungsverfahren und Aufbaukosten festhalten.",
  "conditions": {
    "baseline": "Normale lokale Suche und gezielte Abrufe; kein Graft oder Pilotbericht",
    "graft": "Gleiche Werkzeuge plus festgelegte Graft-Version"
  },
  "tasks": [{
    "id": "task-1",
    "question": "Vorab festgelegte fachliche Frage",
    "cohort": "held_out",
    "criteria": [{"id": "sources", "description": "Vorab festgelegte Pflichtaussage mit unabhängig geprüftem Quellenanker"}]
  }],
  "pairs": [{"id": "task-1-repeat-1", "task": "task-1", "graphState": "warm", "order": ["baseline", "graft"]}]
}
```

Platzhalter ersetzen; `sourceFingerprint` muss aus 64 kleinen Hexadezimalzeichen bestehen. Vor dem ersten Lauf `status` auf `frozen` setzen und `frozenAt` als UTC-Zeit mit Millisekunden eintragen, beispielsweise `2026-09-17T10:00:00.000Z`. Modellrevision, Kriterien und Reihenfolge danach nicht an Ergebnisse anpassen. Planhash erzeugen:

```powershell
node scripts/evaluate-abap-benefit.mjs plan-hash local/experiment/plan.json
```

Jeder Lauf übernimmt diesen Hash. Inhaltsänderungen am Plan machen alte Läufe inkompatibel. Der Hash und der angegebene Zeitpunkt sind Konsistenzprüfungen, kein unabhängiger Beweis einer Vorregistrierung. Entwürfe können mit leeren Laufdaten ausgewertet werden, akzeptieren aber keine Durchläufe.

Ab pilot.27 legt `sourcePolicy` die Quellenpflicht vorab fest. `producer_verified` verlangt gespeicherte erfolgreiche Fingerprint-Ausgaben mit bestätigtem Produzentenstatus vor und nach jedem Lauf. `content_only` erlaubt weiterhin den einfachen Inhaltsvergleich; fehlt das Feld in einem älteren Plan, gilt diese schwächere Regel. Der Bericht nennt die Regel ausdrücklich. Ein Wechsel der Regel verändert den Planhash und darf nicht nachträglich zur Rettung einzelner Läufe erfolgen.

## Laufdaten

`runs.json` enthält ein Array, anfangs `[]`. Eine Beobachtung je geplantem Paar und Arm; Fehlversuche nicht entfernen oder durch eine erfolgreichere Wiederholung ersetzen. Eine neue Wiederholung benötigt ein vorab geplantes eigenes Paar.

```json
{
  "pair": "task-1-repeat-1",
  "arm": "baseline",
  "planHash": "plan:HASH_DES_EINGEFRORENEN_PLANS",
  "sourceFingerprint": "FINGERPRINT_VOR_DEM_LAUF",
  "sourceFingerprintAfter": "FINGERPRINT_NACH_DEM_LAUF",
  "sourceSnapshots": {
    "before": {"path": "evidence/baseline-source-before.json", "sha256": "SHA256_DER_GESPEICHERTEN_JSON_DATEI"},
    "after": {"path": "evidence/baseline-source-after.json", "sha256": "SHA256_DER_GESPEICHERTEN_JSON_DATEI"}
  },
  "modelKey": "EXAKT_WIE_IM_PLAN",
  "sessionId": "eindeutige-frische-sitzung",
  "freshSession": true,
  "outcome": "completed",
  "startedAt": "2026-09-17T10:01:00.000Z",
  "finishedAt": "2026-09-17T10:04:00.000Z",
  "toolCalls": null,
  "fileReads": null,
  "toolRounds": null,
  "sapReads": null,
  "usage": null,
  "artifacts": {
    "answer": {"path": "evidence/baseline-answer.txt", "sha256": "DATEI_SHA256"},
    "trace": {"path": "evidence/baseline-trace.txt", "sha256": "DATEI_SHA256"}
  },
  "review": null
}
```

Relative Artefaktpfade beziehen sich auf den Ordner von `runs.json`. Auch abgebrochene Läufe speichern eine abschließende Fehlermeldung und das bis dahin entstandene Protokoll; `outcome` lautet dann `failed`. Das Skript prüft beide Dateien gegen ihre Prüfsummen. Unbekannte Messwerte ausdrücklich als `null` erfassen. Null bedeutet nicht null Verbrauch; die Zahl `0` ist nur für tatsächlich erfasste Nullwerte vorgesehen.

`sourceSnapshots.before` und `.after` verweisen auf die unverändert gespeicherten JSON-Ausgaben des Fingerprint-Befehls. Ihre Artefaktprüfsummen beziehen sich auf diese JSON-Dateien; sie sind **nicht** der darin enthaltene Quellenfingerprint. Die Auswertung prüft die Dateien, das Format, den Quellenfingerprint, die Dateizahl und die Exportgeneration. Weder Quellenpfade noch Generationen werden in den Ergebnisbericht übernommen.

- Gleiche bestätigte Generation innerhalb eines Laufs und passender Inhalt erfüllen `producer_verified`. Verschiedene Läufe dürfen verschiedene abgeschlossene Generationen desselben Inhalts verwenden.
- Ein belegter Inhalts- oder Generationswechsel macht einen abgeschlossenen Lauf für den Vergleich ungültig; er zählt in der Bilanz als `incorrect`, auch bei fachlich richtiger Antwort. Die zusätzliche Tabelle nennt den Quellenwechsel ausdrücklich. Auch ein `content_only`-Plan ignoriert widersprechende beigefügte Belege nicht.
- Fehlt die erfolgreiche Beobachtung, den betreffenden Verweis als `null` speichern. Keine fehlenden Werte erfinden. Bei `producer_verified` kann ein sonst korrekter Lauf damit nur `unreviewed` bleiben. Ein abgebrochener Lauf bleibt `failed`, seine bekannten Aufwände bleiben erfasst. Fehlerausgaben einer gescheiterten Fingerprint-Abfrage im Laufprotokoll aufbewahren; sie sind keine erfolgreichen Snapshot-JSONs.
- Beschädigte, manipulierte oder falsch formatierte Belegdateien werden als Eingabefehler abgewiesen. Eine erfolgreiche Hashprüfung bestätigt deren gespeicherte Bytes, nicht Herkunft oder Zeitpunkt der Aufnahme. Diese müssen unabhängig im Protokoll geprüft werden; die Auswertung fragt den Export nicht nachträglich ab.

- `toolCalls`: alle Werkzeugaufrufe einschließlich Fehlern und zusätzlichen Abrufen.
- `fileReads`: lokale Quelltextabrufe; die Zählweise für Sammelabrufe im Protokoll festlegen.
- `toolRounds`: sequenzielle Werkzeugrunden; parallel gestartete Aufrufe können eine Runde bilden.
- `sapReads`: SAPRead-Aufrufe separat zählen.
- Zeit wird aus den beiden UTC-Zeitstempeln berechnet; sie muss nach dem Einfrieren des Plans liegen. Überlappende oder zur geplanten Reihenfolge widersprüchliche Arme werden abgewiesen.

Wenn tatsächliche Verbrauchszähler für **alle Modellaufrufe des Durchlaufs** vorhanden sind:

```json
{
  "source": "provider_reported",
  "accounting": "input_including_cache_output_including_reasoning",
  "inputTokens": 1234,
  "outputTokens": 567,
  "counterReference": "im-gespeicherten-trace-vorkommende-kennung"
}
```

Dies ist nur ein Schema mit künstlichen Beispielzahlen. Unter `usage` eintragen, nachdem Zählerdefinitionen geprüft sind: Input einschließlich Cache-Read/Cache-Write, Output einschließlich gegebenenfalls enthaltener Reasoning-Tokens, jede Kategorie genau einmal. Bei Anbietern mit getrennten Cache-Kategorien aus tatsächlichen Zählern entsprechend zusammenführen; bereits enthaltene Kategorien nicht erneut addieren. Werkzeugbeschreibungen und wiederholte Kontexte zählen im tatsächlichen Input mit. Das Skript konvertiert keine anbieterspezifischen Formate und prüft die Zahlen nicht gegen eine Anbieter-API. Der Bewerter muss die angegebenen Gesamtsummen anhand des aufbewahrten Protokolls kontrollieren. Ohne geeignete Zähler bleibt `usage: null`; keine Zeichen/4-Schätzung. Kosten werden nicht berechnet.

Nach unabhängiger Prüfung gegen die eingefrorene Quellenreferenz:

```json
{
  "reviewer": "Bewerterkennung",
  "protocolCompliant": true,
  "unsupportedClaims": 0,
  "criteria": {"sources": true}
}
```

Als `review` eintragen. Alle vorab festgelegten Kriteriumskennungen müssen genau einmal vorhanden sein: `true`, `false` oder noch `null`. Eine unbelegte Behauptung, ein nicht bestandenes Pflichtkriterium oder Protokollverstoß zählt als inkorrekt. Offene Bewertung zählt nicht als Erfolg. Eine begründet unauflösbare Beziehung kann eine richtige Antwort sein, wenn dies der unabhängigen Referenz entspricht. Die Software ersetzt diese Bewertung nicht.

## Auswertung

```powershell
node scripts/evaluate-abap-benefit.mjs summarize --plan local/experiment/plan.json --runs local/experiment/runs.json --out local/experiment/report-01
```

Ausgabe: `result.json` und `report.md`. Vorhandene Berichte werden nicht überschrieben. Berichte enthalten keine Antworttexte, Protokolltexte oder Artefaktpfade; Plan-/Datensatzhash und Quellenfingerprint ermöglichen die Zuordnung. Kennungen und Modellangaben vor externer Weitergabe dennoch auf vertrauliche Angaben prüfen.

Zuerst erscheinen Qualitätszahlen über alle geplanten und erfassten Läufe, einschließlich Fehlern, fehlenden Durchläufen und unbewerteten Antworten. Korrekt bedeutet zusätzlich gemäß Quellenregel zulässig. Die separate Quellenbilanz unterscheidet bestätigte Generation, Quellenwechsel, fehlenden Pflichtbeleg und reinen Inhaltsvergleich, auch je Aufgabe im JSON. Ressourcenunterschiede werden ausschließlich für Paare mit zwei korrekten zulässigen Antworten und verfügbaren Messwerten berechnet. Ausgeschlossene Paare bleiben mit Grund gezählt. Ein positives Ergebnis dieses Teilbestands darf nicht auf alle Aufgaben übertragen werden.

Je Metrik gilt: Reduktion = 100 × (Summe ohne Graft − Summe mit Graft) / Summe ohne Graft. Das ist das Verhältnis der Summen, nicht das Mittel einzelner Prozentwerte. Bei Ausgangswert null bleibt die Prozentzahl undefiniert. Negative Unterschiede bleiben sichtbar. JSON enthält zusätzlich je Aufgabe Median, Minimum und Maximum beider Arme sowie der gepaarten absoluten Unterschiede.

Der gesamte erfasste Aufwand einschließlich fachlich falscher Antworten und Abbrüchen wird separat ausgewiesen. Aufwand pro korrektem Lauf wird erst bei vollständigem, bewertetem Datensatz mit bekannten Messwerten und mindestens einem korrekten Ergebnis berechnet. Ohne Providerzähler gibt es keine Tokenersparnis; ohne Durchläufe gibt es keine Ersparnis überhaupt. Die Auswertung liefert beschreibende Zahlen, keine statistische Signifikanz oder allgemeine Produktivitätsquote.
