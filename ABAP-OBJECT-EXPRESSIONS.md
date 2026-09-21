# NEW und CAST im ABAP-Graphen

Seit `0.18.0-abap-pilot.13` löst Graft Methodenketten mit explizitem Objekt-Typ auf:

```abap
NEW lcl_run( )->run( ).
CAST lif_service( ref )->execute( ).
NEW maker( )->get_child( )->ping( ).
```

Die Klasse beziehungsweise das Interface muss eindeutig im passenden Namensraum des Exports vorhanden sein. Nachfolgende Methodenrückgaben werden mit der RETURNING-Auflösung aus .12 weiterverfolgt. Der aufrufende Block erhält die Kanten; zwischen den Methodenrümpfen wird keine künstliche Aufrufkette erzeugt.

## Konstruktoren getrennt erfassen

Jeder explizit typisierte `NEW`-Ausdruck wird auch außerhalb einer Kette auf einen vorhandenen Instanzkonstruktor geprüft. Konstruktor und Folgemethode behalten ihre jeweils eigenen Argumente und Tokenpositionen. Benannte Argumente werden erfasst; positionale Argumente gelten vorerst als unvollständig, damit keine Defaults als sicher weggelassen interpretiert werden.

Ohne eigenen expliziten Konstruktor wird die bekannte Basiskette bis zum ersten expliziten Konstruktor verfolgt. Die Aufrufstelle kennzeichnet dies als implizite Weiterleitung. Ein eigener Konstruktor beendet diese Suche: Ein zusätzlich erforderlicher `super->constructor`-Aufruf muss aus dessen Quelltext kommen. Graft erzeugt keine künstlichen Knoten für leere implizite Konstruktoren.

Diese Unterscheidung folgt der SAP-7.50-Regel für implizite Konstruktoren und deren Parameterweiterleitung. [SAP: METHODS constructor](https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abapmethods_constructor.htm)

## Belege und Grenzen

`callSites[].receiverType` enthält optional `basis: "new"` oder `"cast"` sowie den originalen Ausdruck mit Datei und Zeilen. Ohne `basis` bleibt die .12-Bedeutung RETURNING erhalten. Die ausführliche Ausgabe nennt `NEW object type` oder `CAST target type` und zeigt den Ausdruck unter `Receiver expression`. Ein CAST kann zur Laufzeit fehlschlagen; die Auflösung behauptet keinen erfolgreichen Cast und wählt keine konkrete implementierende Unterklasse. [SAP 7.50: CAST](https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abenconstructor_expression_cast.htm)

Konstruktorstellen tragen `construction: { className, implicitForwarding }` und erscheinen im Belegtext als `Object construction`. Die Relation bleibt `calls`; eigene Verbraucher des Rohgraphen müssen die zusätzlichen Metadaten berücksichtigen. Erfolgreiche Objekterzeugung und tatsächliche Ausführung werden nicht bewiesen.

Weiter offen bleiben:

- Typinferenz für `CAST #(...)` und NEW-#-Kontexte außerhalb der ab .17 unterstützten direkten Zuweisung, Datentypaliase und Attribut-/Strukturketten zwischen den Aufrufen;
- automatische Klassenkonstruktor-Ausführung;
- konkrete dynamische Unterklassen, vollständige Sichtbarkeits-/Instanziierbarkeitsprüfung und Laufzeitausnahmen;
- unbekannte oder mehrdeutige Klassen, externe Basisklassen und dynamische Typen.

`NEW` für Datenreferenzen wird nicht als Klassenkonstruktoraufruf geraten. Interfaces können CAST-Ziele sein, werden aber nicht als instanziierbare NEW-Klasse verwendet. Gleichnamige lokale Datentypen und Aliase verhindern eine falsche Klassenauflösung.

## Nachweise

`test/abap-constructor-chains.test.ts` enthält 13 Fälle, darunter getrennte und verschachtelte Argumente, Interface-Casts, implizite Weiterleitung, generische/verschattete/mehrdeutige Typen, Parserwiederverwendung und gespeicherte MCP-Belege mit Zielentfernung. Die Belegprüfung umfasst jetzt auch die in `receiverType` gespeicherten Quellenfragmente; ein zusätzlicher negativer Prüffall erkennt falsche Zeilen trotz korrekter äußerer Aufrufstelle.

Im unveränderten Pilot-Export werden 14 zuvor offene NEW-Methodenstellen aufgelöst und 43 Konstruktorstellen erfasst. Sie ergeben 54 zusätzliche Kanten: 701 Knoten, 2.153 Kanten, 982 offene Referenzen und 1.166 Diagnosen. Alle alten Kanten und ihre Belege sowie alle verbleibenden offenen Referenzen sind einschließlich Metadaten erhalten. Jede neue Stelle wurde an ihrer originalen Tokenposition gegengeprüft. Keine neue reale CAST-Stelle; CAST-Semantik ist durch isolierte Tests belegt. Kein SAP-Sync und kein erneuter CE1-Abgleich.

## CREATE OBJECT ab pilot.15

`CREATE OBJECT ref TYPE klasse` erzeugt eine Kante zum vorhandenen Instanzkonstruktor der eindeutig exportierten Klasse. Ohne TYPE wird die unterstützte statische Referenzdeklaration von `ref` verwendet. Lokale Variablen und formale Parameter haben Vorrang vor gleichnamigen Attributen; `me->attribut` wählt das Attribut der Klasse einschließlich belegbarer Vererbung ab .24. Komplexere Attribut-/Strukturzugriffe, unvollständige Vererbung, LIKE-/Alias-Typen und generische Referenzen werden nicht geraten.

Die SAP-Dokumentation nennt den Instanzkonstruktoraufruf und die Parameterweiterleitung zum ersten expliziten Konstruktor der Basiskette. Deshalb nutzt CREATE OBJECT dieselbe Konstruktorauflösung wie NEW. Eine vollständig bekannte Basiskette ohne expliziten Konstruktor erzeugt weder einen künstlichen Knoten noch eine fehlende Referenz. Unvollständige oder zyklische Vererbung bleibt dagegen als `resolution_incomplete` sichtbar. [SAP 7.50: CREATE OBJECT](https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abapcreate_object.htm)

Ein unmittelbar angegebener großgeschriebener Klassenname als Zeichenliteral, etwa `TYPE ('ZCL_SERVICE')`, wird ebenfalls aufgelöst. Bei Variablen oder Konstantennamen in der dynamischen TYPE-Form bleibt der Aufruf offen; Konstantenwerte und Zuweisungen werden nicht ausgewertet. Ein kleingeschriebenes Literal wird nicht still in Großbuchstaben umgewandelt. Bei explizitem TYPE wird keine spätere Verwendung einer generischen Zielreferenz auf diesen Laufzeittyp umgedeutet. [SAP 7.50: CREATE OBJECT – TYPE](https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abapcreate_object_explicit.htm)

EXPORTING-Argumente bleiben von EXCEPTIONS-Zuordnungen und verschachtelten Methodenargumenten getrennt. PARAMETER-TABLE setzt `argumentsComplete=false`; Default-Werte dürfen daraus nicht als sicher weggelassen abgeleitet werden. AREA HANDLE ändert die bekannte Konstruktorbeziehung nicht. Das Vorhandensein einer Kante beweist weder erfolgreiche Erzeugung, Instanziierbarkeit noch den Erfolg des Shared-Object-Zugriffs.

Jede Kettenanweisung `CREATE OBJECT: a, b` erhält eine eigene Aufrufposition am jeweiligen Zieloperand. Zeilen, Argumente, umschließende Bedingungen und bisherige Zuweisungen werden mit den vorhandenen Belegmechanismen gespeichert. Fehlende oder mehrdeutige Klassen und dynamische Typen erscheinen im Inventar unter `target_kind="method"` und Zielnamen wie `KLASSE->CONSTRUCTOR`.

16 Fälle in `test/abap-create-object.test.ts` sichern die Auflösung, Grenzen, Vererbung, Parametertabellen, Kettenschreibweise, Parserwiederverwendung und den echten MCP-Refresh nach Zielentfernung ab. Im Pilot-Export werden alle elf CREATE-OBJECT-Stellen erfasst: vier neue Konstruktor-Kanten und sieben neue offene Referenzen auf nicht exportierte Standardklassen. Neuer Bestand: 701 Knoten, 2.157 Kanten, 989 offene Referenzen und 1.173 Diagnosen. Die höhere Referenzzahl bedeutet zusätzliche Sichtbarkeit bisher nicht erfasster Aufrufe. Alle alten Knoten, Kanten, Aufrufbelege und offenen Referenzen sind unverändert erhalten. Quellenvergleich: `local/compare-pilot14-15.mjs`.

## NEW # mit direktem Zuweisungsziel ab pilot.17

```abap
DATA ref TYPE REF TO lcl_service.
ref = NEW #( ).
```

Bei einer direkten Zuweisung kann der unabhängig deklarierte Zieltyp den Typ für `#` liefern. Graft berücksichtigt einfache Variablen, eigene Attribute einschließlich `me->attribut`, erfasste formale Parameter einschließlich RETURNING sowie vorher belegte Inline-Referenztypen. Die Deklaration wird in ihrem eigenen Namensraum ausgewertet; eine lokale Datentypdeklaration im Methodenrumpf darf beispielsweise einen bereits in der Klasse deklarierten Attributtyp nicht ersetzen. Unknown-/LIKE-/Alias-Deklarationen verdecken ältere Bindungen, statt deren Typ zu übernehmen.

Diese Erweiterung folgt der Regel, dass `#` einen eindeutig erkennbaren Typ der Operandenposition übernimmt. NEW kann sowohl Daten- als auch Objektreferenzen erzeugen. Deshalb wird nur bei einer eindeutig bekannten Klasse eine Konstruktor-Kante abgeleitet. Eine nicht exportierte Typdefinition wird nicht automatisch als fehlender Klassenkonstruktor eingestuft. [SAP ABAP 7.50: NEW](https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abenconstructor_expression_new.htm)

Die gesamte rechte Seite muss dieser einzelne NEW-Ausdruck sein. Verschachtelte `NEW #`-Argumente erhalten nicht den Typ des äußeren Ziels. Bei `ref = NEW #( )->method( )` wird die Objektklasse nicht rückwärts aus dem Typ des letzten Methodenresultats geraten. `DATA(ref) = NEW #( )` liefert ebenfalls keinen unabhängigen Zieltyp. Andere Typkontexte, komplexe Ziele, generische Referenzen, Interfaces und nicht eindeutig bekannte Klassen bleiben außerhalb dieser Ableitung.

Konstruktorvererbung wird wie beim expliziten NEW behandelt. Für leere implizite Konstruktoren werden keine künstlichen Knoten angelegt. `construction.inferredType` nennt `target` und die originale Typquelle in `source`; bei einem vorher inline deklarierten Ziel kommt dessen `inlineDeclaration` hinzu. Die Ausgabe enthält `Constructor type from assignment target …` und `Assignment target type declaration`. Alle Quellenfragmente werden separat geprüft. Die Darstellung beweist weder erfolgreiche Erzeugung noch tatsächliche Ausführung.

16 Fälle in `test/abap-inferred-new.test.ts` prüfen Deklarationen, Namensräume, lokale Verdeckung, Parameter, implizite Basiskonstruktoren, negative Typ-/Kontextfälle, Quellenbelege, AST-Wiederverwendung und MCP-Refresh nach Typänderung. Im unveränderten Pilot-Export entstehen acht Konstruktorstellen und fünf Kanten: sieben Stellen in den BUILD_EXTRACTOR-Fabriken der vier Vergleichs-/Export-/HTML-/JSON-Reports sowie eine Stelle im Test-Wrapper. Bestand: 701 Knoten, 2.167 Kanten, 983 offene Referenzen.

Der exportbezogene Quellenvergleich zählt 17 aktive NEW-#-Stellen. Neben den acht neuen Belegstellen betreffen sechs Klassen ohne expliziten Konstruktor und ohne deklarierte Basisklasse; drei weitere beziehen sich auf die nicht exportierte CL_ABAP_ZIP. Eine kommentierte Stelle wurde nicht gezählt. Alle bisherigen Knoten, Kanten, Aufrufbelege, offenen Referenzen und Diagnosen bleiben unverändert. Reproduktion: local/compare-pilot16-17.mjs; Bericht: local/pilot17-vs-pilot16.json. Dieser Nachweis bezieht sich auf den Clone, nicht auf einen neuen CE1-Abgleich.

## Qualifizierte Attributziele ab pilot.22

`CREATE OBJECT holder=>service` und `holder=>service = NEW #( )` verwenden seit .22 die direkte `CLASS-DATA`-Deklaration einer eindeutigen Klasse. Seit .24 wird auch eine belegte geerbte Deklaration genutzt, einschließlich geschützter Attribute innerhalb der nachgewiesenen Hierarchie. Private Attribute bleiben auf ihre deklarierende Klasse beschränkt. Instanzattribute mit Klassenselektor, generische Typen, Attributaliase und komplexere Komponentenketten bleiben offen. Quellenbelege zeigen Originaldeklaration und bei Vererbung die benötigten Klassenheader. Fehlende geerbte CREATE-OBJECT-Ziele behalten den ursprünglichen Ausdrucksnamen und ihre Referenzkennung. Die übrigen Konstruktorregeln bleiben erhalten. Ausführlicher Vertrag und Tests: [Geerbte Attribute](ABAP-RETURN-CHAINS.md#geerbte-attribute-ab-pilot24).

## Sichtbare Analysegrenzen bei NEW ab pilot.20

Nicht eindeutig eingeordnete NEW-Ausdrücke erzeugen jetzt `unresolved_construction`-Diagnosen. Abfragbar über `graft_diagnostics` mit `kind="unresolved_construction"` oder `node pilot/run.mjs notices --kind unresolved_construction --evidence`. Die Meldung nennt den geschriebenen Typ und, bei unterstützter direkter #-Zuweisung, den nicht aufgelösten deklarierten Zieltyp. Bei bekannten Klassen mit unvollständiger oder zyklischer Konstruktorvererbung bezeichnet sie diese Grenze ausdrücklich.

Diese Hinweise sind keine offenen Methodenaufrufe: NEW kann ein Datenobjekt oder eine Klasseninstanz erzeugen. Ohne eindeutige Typdefinition wäre eine angenommene CONSTRUCTOR-Referenz bereits zu viel behauptet. Die Einordnung folgt der [SAP-7.50-Dokumentation zu NEW](https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abenconstructor_expression_new.htm). Die Meldung beweist weder ungültigen Code noch ein fehlendes Objekt in SAP.

Bekannte Datenkonstruktionen bleiben ohne Konstruktorhinweis: konkrete eingebaute Datentypen, sichtbar deklarierte TYPES einschließlich Referenztypen, bekannte geerbte Datentypen und eindeutige exportierte TABL-/DTEL-/TTYP-Typen. Eine vollständig bekannte Klassenhierarchie ohne expliziten Konstruktor erhält ebenfalls keine Meldung und keinen künstlichen Knoten. Ein vorhandener eigener Konstruktor bleibt verwendbar, auch wenn eine Basisklassendeklaration fehlt. Komplexe Typ-/Alias-Kontexte können weiterhin einen konservativen Hinweis erzeugen.

Jeder Hinweis enthält die einbasierte Zeile und Spalte des NEW-Tokens sowie die unveränderte Originalzeile. Gleichartige Konstruktionen auf derselben Zeile werden dadurch getrennt erfasst. Die Spalte ist Teil der neuen Diagnosekennung; alle bisherigen Kennungen ohne Spalte bleiben exakt erhalten. Der Trace zeigt diese Kategorie bei betroffenen Ausgangsmethoden auch mit evidence=false an, ohne Quellenblock. Diese strukturelle Analysegrenze ist keine hypothetische Default-Annahme. Der Quellenbeleg im Diagnoseinventar ist eine Zeile, nicht zwingend die vollständige mehrzeilige Konstruktion.

14 Tests prüfen unbekannte und verschachtelte Konstruktionen, Datentypen, leere/fehlende/zyklische Konstruktorhierarchien, gleiche Zeilen, Kommentare/Strings, Quellenpositionen und alte Kennungen. Ein unveränderter Aufrufer verliert seinen Hinweis und erhält eine Konstruktor-Kante, sobald die fehlende Klasse in einer anderen Datei exportiert wird. Wiederverwendeter Parserstand und kalte Analyse stimmen überein; MCP weist die dadurch geänderte Inventarrevision zurück.
