# ABAP-Aufrufe: Start, Registrierung und Callback

Seit pilot.11 enthalten betroffene Aufrufstellen das optionale Feld `callSites[].execution`. Normale Aufrufkanten und Referenzkennungen bleiben im bisherigen Format. Eine Kante beschreibt eine statische Beziehung; sie ist keine Aussage, dass die gesamte Kette sofort, in einer Sitzung oder überhaupt ausgeführt wird.

| Modus | Aufgezeichnete Syntax | Grenze der Aussage |
|---|---|---|
| `callback` | `CALLING … ON END OF TASK` oder `PERFORMING … ON END OF TASK` | Callback wird registriert; Laufzeitargumente werden nicht als weggelassen behandelt |
| `async` | `STARTING NEW TASK` | Aufrufer wartet nicht auf Abschluss des Funktionsbausteins |
| `update_task` | `IN UPDATE TASK` | Registrierung für Verbuchungsverarbeitung; COMMIT wird nicht bewiesen |
| `background_task` | `IN BACKGROUND TASK` | Registrierung eines Hintergrund-RFC; dessen Verarbeitung wird nicht simuliert |
| `background_unit` | `IN BACKGROUND UNIT` | Zielverbindung steckt im Unit-Objekt; ohne deren Auflösung keine lokale Funktionskante |
| `on_commit` | `PERFORM … ON COMMIT` | FORM wird für COMMIT WORK registriert |
| `on_rollback` | `PERFORM … ON ROLLBACK` | FORM wird für ROLLBACK WORK registriert |

Die Erkennung verwendet direkte Schlüsselwörter des Syntaxbaums. Parameter namens `task`, `update` oder `background` lösen keine solche Einstufung aus. Eine fehlende Kennzeichnung ist besonders in älteren Graphen kein Beweis synchroner Ausführung.

Die SAP-Dokumentation beschreibt die Rückrufe nach Abschluss eines asynchronen RFC und die Registrierung von Verbuchungsbausteinen beziehungsweise FORMs bis zum Commit. [SAP: STARTING NEW TASK](https://help.sap.com/saphelp_gbt10/helpdata/EN/48/89389984b84e6fe10000000a421937/content.htm), [SAP 7.50: COMMIT WORK](https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abapcommit_shortref.htm)

## Sichtbarkeit in Abfragen

Eine Kurzliste zeigt beispielsweise:

```text
[execution boundary: callback; at least one recorded site starts or registers asynchronous/deferred work. This chain does not establish synchronous execution.]
```

Dieser Hinweis bleibt mit `evidence=false`, `evidence_targets=[]` oder einer Begrenzung der dargestellten Aufrufstellen erhalten. Kombiniert eine Kante normale Aufrufe und Registrierungen, bezieht er sich ausdrücklich auf mindestens eine aufgezeichnete Stelle. Die ausführlichen Belege erklären den Modus. Bedingungen und frühere Abbrüche am Registrierungsort werden nicht als Bedingungen einer bereits bewiesenen Callback-Ausführung ausgegeben.

Offene Referenzen erhalten auch ohne Belegtext eine Kennzeichnung wie `[execution: callback]`. Ein entfernter RFC bleibt eine offene Funktionsreferenz; ein eindeutig lokaler Callback kann unabhängig davon aufgelöst werden. Graft erzeugt keine künstliche Kante vom entfernten Funktionsbaustein zum Callback.

Bei `IN BACKGROUND UNIT` enthält das Unit-Objekt die Zielverbindung. Auch ein gleichnamiger lokaler Funktionsbaustein genügt deshalb nicht zur Auflösung: Die Referenz bleibt mit `reason=remote` und `execution=background_unit` offen. Das bedeutet unbekannte RFC-Zuordnung, nicht bewiesene Ausführung auf einem anderen System. [SAP: bgRFC-Unit und Destination](https://help.sap.com/saphelp_snc700_ehp04/helpdata/en/48/96de810eec3987e10000000a421937/content.htm)

Die Default-Analyse berücksichtigt solche Ausführungsgrenzen nicht als unmittelbare Übergaben. Callback-Argumentlisten sind ausdrücklich unvollständig. Ebenso werden dynamische `PARAMETER-TABLE`-/`EXCEPTION-TABLE`-Formen nicht als vollständig leere Argumentlisten ausgegeben; tatsächlich leere normale Listen bleiben vollständig.

## Prüfung und Grenzen

`node --import tsx --test test/abap-execution.test.ts` prüft acht isolierte Fälle, einschließlich gespeicherter Graphdaten und echter MCP-Toolhandler, gemischter Aufrufstellen, Belegfilter, unbekannter/dynamischer Ziele und Parserwiederverwendung.

Im unveränderten Pilot-Export kommen diese Modusformen nicht vor. Dort sind Knoten, Kanten, offene Referenzen und Diagnosen gegenüber .10 identisch. Das belegt die Regression, nicht die Callback-Semantik in CE1. Keine SAP-Laufzeitprüfung, kein COMMIT/ROLLBACK-Flow, keine garantierte Callback-Ausführung und keine allgemeine Modellierung von Events, Jobs oder anderen Framework-Callbacks.

Eigene Verbraucher des Rohgraphen müssen `callSites[].execution` berücksichtigen. Die zusätzliche Information ändert die bestehende Relation `calls` nicht; sie wird in Grafts Trace-Ausgabe erläutert.
