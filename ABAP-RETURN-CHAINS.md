# Rückgabetypen in ABAP-Methodenketten

Seit `0.18.0-abap-pilot.12` verfolgt Graft funktionale Methodenketten über explizite `RETURNING … TYPE REF TO <Klasse/Interface>`-Deklarationen weiter. Beispiel:

```abap
CLASS-METHODS make RETURNING VALUE(result) TYPE REF TO leaf.
...
maker=>make( )->ping( ).
```

Sind `make`, seine Rückgabedeklaration, `leaf` und `ping` eindeutig im Export vorhanden, erhält der aufrufende Block Kanten zu `make` und `ping`. Es entsteht keine künstliche Kante von `make` zu `ping`: Der zweite Aufruf steht beim Aufrufer, nicht zwangsläufig im Rumpf der Fabrikmethode. Die zusätzliche Auflösung aus dem deklarierten Typ gilt als `inferred`.

Die SAP-Sprachbeschreibung legt fest, dass die vollständige Typisierung des RETURNING-Parameters den Typ des funktionalen Operanden bestimmt. Graft nutzt diese Deklaration; es simuliert weder die Methode noch die konkrete Objektinstanz. [SAP: funktionaler Methodenaufruf](https://help.sap.com/docs/abap-cloud/abap-keyword/meth-functional-method-call)

## Belege

Eine ausführliche Trace-Ausgabe ergänzt beispielsweise:

```text
Receiver static type: LEAF (RETURNING declaration; runtime subtype not inferred).
Returning declaration: src/...:L...
CLASS-METHODS make RETURNING VALUE(result) TYPE REF TO leaf.
```

Die Belege werden als optionales `callSites[].receiverType` mit `name` und `source` gespeichert. Sie beziehen sich auf den unmittelbar vorhergehenden Methodenaufruf. Verschachtelte Aufrufe in Argumenten liefern nicht den Empfängertyp der äußeren Kette. Jede Aufrufstelle behält ihre eigenen Argumente und Tokenpositionen.

Der Typ wird im Gültigkeitsbereich seiner Deklaration aufgelöst. Gleichnamige lokale Klassen oder Datentypen beim Aufrufer dürfen ihn nicht ersetzen. Interface-Rückgaben führen zur passenden Interface-Deklaration; eine konkrete implementierende Laufzeitklasse wird nicht gewählt. Vorhandene Aliasauflösung wird berücksichtigt. Bei `REDEFINITION` wird der Rückgabevertrag aus der vorhandenen Basismethodendeklaration übernommen; die Aufrufkante zur reimplementierten Methode bleibt erhalten.

## Bewusste Grenzen

- Generische Rückgaben wie `REF TO object`/`data`, Datentypen, `LIKE`, Typaliase und nicht eindeutige Klassendefinitionen liefern keine geratene Fortsetzung.
- Gleichnamige Datentypen beziehungsweise Aliase in der deklarierenden Klasse oder ihren bekannten Basisklassen verhindern eine Klassentyp-Annahme. Bei unbekannten Basisklassen wird ebenfalls konservativ abgebrochen.
- Attribute oder Strukturkomponenten zwischen Methoden bleiben offen. Seit .13 sind explizit typisierte `NEW`-/`CAST`-Anfänge ergänzt: [Objektausdrücke](ABAP-OBJECT-EXPRESSIONS.md). Die Inline-Inferenz aus Fabrikzuweisungen ist ab .16 im unten beschriebenen Umfang enthalten.
- Ein statisch aufgelöster Empfängertyp beweist weder eine gebundene Referenz noch eine konkrete Laufzeit-Unterklasse, fehlerfreie Rückkehr oder tatsächliche Ausführung.
- Gelöschte Ziele entfernen die Kante nach dem Refresh auch aus unveränderten Aufrufern. Die Aufrufstelle bleibt als offene Referenz sichtbar. Eine Löschung im Export beweist keine Löschung in SAP.

## Prüfung

`node --import tsx --test test/abap-return-chains.test.ts` prüft 14 Fälle, darunter mehrstufige Ketten, eigene Argumente, verschachtelte Aufrufe, Interface-Aliase, Redefinitionen, getrennte Namensräume, verschattende Datentypen, fehlende/mehrdeutige Ziele, Kettendeklarationen und gespeicherte MCP-Belege mit Refresh nach Zielentfernung.

Stand .12 entstand im unveränderten Pilot-Export mit dieser Erweiterung keine zusätzliche Kante. Knoten, Kanten, offene Referenzen und Diagnosen waren einschließlich Metadaten identisch zu .11. Das war eine Regressionsprüfung, kein CE1-Nachweis der neuen Semantik. .13 ergänzt inzwischen NEW-Ketten wie `NEW lcl_run( )->run( )`; die offenen SAP-Standardketten bleiben offen.

## Deklarationsbereiche für Referenzen ab pilot.21

Normale Referenzaufrufe und implizites `CREATE OBJECT ref` lösen den statischen Typ jetzt im Bereich der ursprünglichen Deklaration auf, wie bereits die direkte Zuweisung `ref = NEW #( )`. Ein lokales `TYPES leaf TYPE i` in einer Methode ändert nicht den Typ eines zuvor als `REF TO leaf` deklarierten Attributs oder Formalparameters. Umgekehrt verhindert ein im Deklarationsbereich sichtbarer Datentyp gleichen Namens eine geratene Kante zu einer Klasse. Fehlende Basisklassendeklarationen erlauben keine sichere Aussage über geerbte Datentypnamen; solche Aufrufe bleiben offen. Generische oder nicht unterstützte lokale Deklarationen verdecken weiterhin gleichnamige Attribute.

Die gemeinsame Auflösung bewahrt die bisherigen Inline-RETURNING-/CAST-Typbelege und den Namensraum der jeweiligen Deklaration. `receiverType.basis="declaration"` ergänzt den Originalquelltext einfacher Referenzdeklarationen einschließlich unmittelbarer Inline-NEW-Deklarationen. Trace und Inventar offener Aufrufe zeigen ihn als `Reference declaration`; bei `evidence=false` entfällt dieser Quellenblock. Referenzbindung, Laufzeit-Unterklasse und tatsächliche Ausführung werden daraus nicht abgeleitet. Allgemeine Attributketten, zusätzliche Typaliasauflösung und bisher nicht erfasste geerbte Attribute sind dadurch nicht ergänzt.

Elf Tests in `test/abap-reference-scope.test.ts` prüfen unterschiedliche Deklarationsbereiche, lokale Maskierung, geerbte/fehlende Typinformationen, explizite Konstruktorziele, unabhängige Quellenvalidierung, AST-Wiederverwendung und gespeicherte MCP-Ausgaben mit Aktualisierung. Acht der ersten neun Fälle scheiterten vor der Korrektur. Im unveränderten Pilot-Export bleiben Knoten, Kanten, ursprüngliche Aufrufbelege, offene Referenzkennungen und Diagnosen erhalten. Hinzu kommen 223 Deklarationsbelege auf Kanten und 295 bei offenen Referenzen. Die Inhaltsrevision der offenen Referenzen ändert sich entsprechend; eine alte Seitennavigation muss neu begonnen werden.

Sprachgrundlage: SAP ABAP 7.50 beschreibt den statischen Referenztyp als Eigenschaft der Deklaration und unterscheidet ihn vom dynamischen Typ: [DATA – REF TO](https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abapdata_references.htm). Die explizite Klassenauswahl bei Konstruktion bleibt getrennt: [CREATE OBJECT](https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abapcreate_object.htm).

## Qualifizierte Attribute ab pilot.22

```abap
me->service->run( ).
holder=>service->run( ).
CALL METHOD holder=>service->run EXPORTING value = input.
```

Graft nutzt seit .22 die direkte Attributdeklaration der eigenen Klasse beziehungsweise der eindeutig benannten Klasse. Eigene Attribute werden durch gleichnamige lokale Variablen nicht verdeckt. Der Klassenselektor `=>` verlangt ein `CLASS-DATA`-Attribut; ein `DATA`-Instanzattribut oder Methodenparameter darf es nicht ersetzen. Öffentliche statische Attribute sind auch von außen auflösbar. Seit .24 werden zusätzlich geerbte Attribute und geschützte Zugriffe innerhalb der belegten Hierarchie unterstützt, wie unten beschrieben. Über Aliase benannte Attribute sowie beliebige Ketten wie `obj->child->run( )` bleiben außerhalb dieser Erweiterung. Dies ist keine vollständige ABAP-Sichtbarkeitsprüfung.

Der Typ wird weiterhin im Bereich seiner ursprünglichen Deklaration aufgelöst. Trace und offene Referenzen zeigen die Originalquelle unter `Reference declaration`. Nach einem aufgelösten Methodenaufruf kann die bestehende RETURNING-Auflösung fortfahren. Dynamische Namen und generische oder mehrdeutige Typen ergeben keine geratene Kante. Fehlt nur die deklarierte Zielklasse im Export, erscheint `missing_target` mit Typbeleg. Die bisherigen Ausdrucksnamen und Kennungen offener qualifizierter Methodenaufrufe bleiben erhalten; das ist keine Aussage über die Existenz der Klasse in SAP.

Die gleiche Typauflösung unterstützt jetzt `CREATE OBJECT holder=>service` und direkte Zuweisungen `holder=>service = NEW #( )`. Dabei gelten dieselben Sichtbarkeits- und Eindeutigkeitsgrenzen. Siehe [Objektausdrücke](ABAP-OBJECT-EXPRESSIONS.md).

Zwölf Tests in `test/abap-qualified-attributes.test.ts` prüfen eigene/statische Attribute, klassische/funktionale Aufrufe, eigene Argumente, RETURNING-Fortsetzungen, Konstruktoren, falsche Selektoren, Sichtbarkeit, Maskierung, Mehrdeutigkeit, Namensräume, ursprüngliche Referenzkennungen, AST-Wiederverwendung und gespeicherte MCP-Abfragen mit Refresh. Sieben der ersten zehn Fälle scheiterten vor der Umsetzung.

Im Pilot-Export betrifft dies zwei Stellen in einem Report: `lcl_app=>go_html->do_refresh( )` mit einer als `CL_GUI_HTML_VIEWER` deklarierten Referenz. Beide Referenzen bleiben mangels exportierter Zielklasse offen; ihre Ursache wechselt von `unresolved_receiver` zu `missing_target`, und sie erhalten den Deklarationsbeleg. Die Kennungen bleiben `unresolved:61bbdba510037a05` und `unresolved:47c847ff9cdbaf1d`. Alle Knoten, Kanten, übrigen Referenzen und bisherigen Aufrufbelege bleiben unverändert. Zwei zugehörige Diagnosen wechseln zur Kategorie `external_call`. Beide Inventarrevisionen ändern sich; alte Fortsetzungen müssen neu bei Offset 0 beginnen.

Sprachgrundlage mit dem gleichen Muster `factory=>oref->do_something( )`: [SAP ABAP 7.50: Class Component Selector](https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abenclass_component_selector.htm). Bindung und tatsächliche Ausführung der Referenz werden nicht bewiesen.

## Geerbte Attribute ab pilot.24

```abap
CLASS parent DEFINITION.
  PROTECTED SECTION.
    DATA service TYPE REF TO zservice.
ENDCLASS.
CLASS child DEFINITION INHERITING FROM parent.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS child IMPLEMENTATION.
  METHOD run.
    service->execute( ).
    me->service->execute( ).
  ENDMETHOD.
ENDCLASS.
```

Die Auflösung verfolgt die exportierten Basisklassen bis zur ursprünglichen Attributdeklaration. Deren Namensraum bestimmt den Referenztyp; lokale Typen oder Klassen beim Aufrufer dürfen ihn nicht ersetzen. Unterstützt sind unqualifizierte Referenzen, `me->attr` und statische Attribute über `klasse=>attr`, jeweils mit funktionalen oder klassischen Methodenaufrufen. Die gemeinsame Auflösung gilt auch für implizites `CREATE OBJECT` und direkte `NEW #( )`-Zuweisungen.

Öffentliche Attribute sind von außen zugänglich. Geschützte Attribute werden innerhalb ihrer deklarierenden Klasse und nachweisbarer Unterklassen berücksichtigt, auch über einen statischen Klassenselektor. Private Attribute der Basisklasse werden nicht als geerbte Namen verwendet. Jede Klasse behält ihre eigenen privaten Deklarationen. Ein Klassenname vor `=>` verlangt weiterhin CLASS-DATA. Freundschafts- und paketabhängige Sonderrechte werden nicht ausgewertet.

Lokale Variablen und Parameter haben Vorrang vor einem gleichnamigen geerbten Attribut; explizites `me->attr` umgeht diese lokale Maskierung. Ein geerbtes Attribut hat wiederum Vorrang vor einer Programmvariablen, auch wenn sein Typ generisch oder nicht unterstützt ist. Bei fehlenden oder mehrdeutigen Basisklassen beziehungsweise Zyklen wird nicht auf eine gleichnamige Programmvariable ausgewichen. Ein unsichtbares privates Basisattribut verdeckt dagegen keinen sichtbaren Programmnamen in der Unterklasse.

`receiverType.basis="inherited_attribute"` trägt die Originaldeklaration unter `Reference declaration`. `via` zeigt die erforderlichen Klassenheader unter `Attribute inheritance`. Bei geschütztem statischem Zugriff kann dies zusätzlich den Vererbungspfad der aufrufenden Klasse umfassen. NEW-#-Konstruktoren übernehmen diese Quellen als Zuweisungszielbelege. Alle Quellen werden einzeln validiert; `evidence=false` blendet sie aus. Fehlende Zielklassen bleiben offene Referenzen mit ursprünglichem Ausdrucksnamen und ursprünglicher Kennung, einschließlich CREATE OBJECT. Statische Typen beweisen keine gebundene Referenz oder Laufzeit-Unterklasse.

17 Tests in `test/abap-inherited-attributes.test.ts` prüfen Sichtbarkeit, mehrstufige Vererbung, lokale und globale Maskierung, Namensräume, Konstruktoren, Kennungen, ungültige Hierarchien, unabhängige Quellenvalidierung, AST-Wiederverwendung und gespeicherte MCP-Abfragen mit Refresh bei Basisänderungen. Der allgemeine Installationstest führt zusätzlich einen geerbten statischen Attributaufruf über einen separaten stdio-MCP-Prozess aus.

Der aktuelle Pilot-Export enthält keine exportierte Vererbungsbeziehung zwischen zwei Klassen. Die Erweiterung ist für diesen Fall eine unveränderte Regression, kein Nachweis zusätzlicher Abdeckung oder Ersparnis. Die neue Semantik ist anhand synthetischer ABAP-Quellen geprüft; eine unabhängige Gegenprüfung auf einem zweiten echten ABAP-Bestand bleibt offen.

Sprachgrundlagen: [SAP ABAP 7.50: Inheritance](https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abeninheritance.htm) und [SAP: Inheritance and Static Attributes](https://help.sap.com/saphelp_autoid2007/helpdata/EN/dd/4049c40f4611d3b9380000e8353423/content.htm).

## Inline-CATCH-Referenzen ab pilot.23

```abap
CATCH cx_problem INTO DATA(error).
  error->get_text( ).
```

Bei einer Exception-Klasse ist der statische Typ der Inline-Referenz ihr Klassenname. Bei mehreren Klassen sucht Graft die nächstgelegene gemeinsame Oberklasse anhand der exportierten Klassendeklarationen. Fehlende oder mehrdeutige Vererbungswege rechtfertigen keine pauschale Annahme von CX_ROOT: Eine nähere gemeinsame Klasse könnte im Export fehlen. Ist eine gemeinsame Klasse bereits bewiesen, darf ihre darüberliegende Hierarchie fehlen. Zyklen oder wiederholte Klassennamen liefern keine Ableitung.

`receiverType.basis="inline_catch"` enthält die originale CATCH-Anweisung als `source`. Bei mehreren Klassen enthält `via` zusätzlich die benötigten Vererbungsdeklarationen. Trace und offene Referenzen zeigen diese unter `CATCH declaration` und `Receiver type hierarchy`; die Quellenvalidierung prüft jeden Ausschnitt unabhängig. Bei direktem `NEW #( )` mit einem solchen Zuweisungsziel werden die Hierarchiequellen ebenfalls übernommen. Mit `evidence=false` entfallen die Quellenblöcke.

Die Information gilt erst nach der Inline-Deklaration und nur für deren Variablenbindung. Ein schon deklariertes `CATCH ... INTO error` wird nicht auf den gefangenen Typ verengt. Die statische Deklaration gilt auch nach ENDTRY; daraus folgen weder die Ausführung des Handlers noch eine gebundene Referenz oder eine bestimmte Laufzeit-Unterklasse. Ein einzelner nominal bekannter, aber nicht exportierter Typ liefert einen Typbeleg und weiterhin ein offenes Ziel. Ursprünglicher Ausdrucksname und Referenzkennung bleiben erhalten.

16 Tests in `test/abap-catch-references.test.ts` prüfen einfache und mehrfache CATCH-Anweisungen, BEFORE UNWIND, Reihenfolge auf derselben Zeile, getrennte Methoden, bekannte und lückenhafte Hierarchien, Mehrdeutigkeit, unveränderte bestehende Variablen, Konstruktorverwendung, manipulierte Quellenbelege, AST-Wiederverwendung und gespeicherte MCP-Abfragen mit Aktualisierung. Elf der ersten 14 Fälle scheiterten vor der Umsetzung.

Im unveränderten Pilot-Export erhalten 19 offene Aufrufe aus einfachen CATCH-Anweisungen den Typbeleg. Ihre Ursache wechselt von `unresolved_receiver` zu `missing_target`; alle Kennungen bleiben erhalten. Alle 701 Knoten, 2.167 Kanten einschließlich bisheriger Aufrufbelege und die übrigen 964 offenen Referenzen bleiben identisch. Es gibt weiterhin 983 offene Referenzen und 1.176 Diagnosen; 19 zugehörige Diagnosen wechseln zu `external_call`. Beide Inventarrevisionen ändern sich, daher müssen alte Fortsetzungen bei Offset 0 neu beginnen. Mehrfach-CATCH ist durch synthetische Prüffälle belegt, nicht durch diesen Export. Kein neuer CE1-Abgleich.

Sprachgrundlage: [SAP ABAP 7.50: CATCH](https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abapcatch_try.htm).

## Inline-Referenzen ab pilot.16

```abap
DATA(ref) = factory=>make( ).
ref->execute( ).
DATA(next) = ref->next( ).
next->execute( ).
```

Bei einer unmittelbaren Inline-Zuweisung bestimmt der deklarierte Objektrückgabetyp des letzten Methodenaufrufs den statischen Typ der neuen Variablen. Graft löst diesen Typ weiterhin im Namensraum der Rückgabedeklaration auf, auch wenn beim Aufrufer eine gleichnamige lokale Klasse existiert. Dasselbe gilt für `DATA(ref) = CAST klasse( ... )` anhand des expliziten Cast-Zieltyps. Ein späterer Methodenaufruf oder CREATE OBJECT kann diese statische Referenzinformation verwenden.

Die Typisierung einer Inline-Deklaration erfolgt zur Übersetzungszeit, unabhängig von der tatsächlichen Ausführung. Deshalb bleibt sie auch hinter einer bedingten Deklaration verwendbar. Eine gesetzte oder gültige Objektinstanz wird damit nicht behauptet. [SAP ABAP 7.50: DATA – Inline Declaration](https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abendata_inline.htm)

Graft übernimmt die Information erst nach der deklarierenden Anweisung und nur in der zugehörigen Variablenbindung. Aufrufe davor oder verschachtelte Lesezugriffe in derselben Anweisung erhalten sie nicht. Normale Zuweisungen verändern keinen vorhandenen statischen Variablentyp. Insbesondere wird aus `ref = NEW unterklasse( )` keine Typverfeinerung einer zuvor generisch deklarierten Referenz abgeleitet.

Die neue Ableitung unterstützt den unmittelbaren RHS-Methodenaufruf, vollständige bekannte Rückgabeketten und explizite CAST-Ausdrücke. COND-/SWITCH-Ausdrücke, Typaliase, #-Inference, unbekannte Rückgabeklassen, komplexe Attributketten und andere Inline-Positionen werden dadurch noch nicht allgemein aufgelöst. CATCH ist seit .23 im nachfolgend beschriebenen Umfang ergänzt; RECEIVING bleibt außerhalb dieser Ableitung. Fehlende SAP-Standarddeklarationen bleiben fehlend.

Dabei wurde eine bisher falsche NEW-Annahme korrigiert: `DATA(ref) = NEW klasse( )->methode( )` hat den Rückgabetyp der Methode, nicht automatisch den Typ klasse. Ebenso kann `NEW klasse( )->attribut` nicht einfach als klasse typisiert werden. Die bisherige NEW-Kurzregel ist deshalb auf einen alleinstehenden NEW-Ausdruck begrenzt.

### Zusätzliche Belege

`receiverType.basis` kann jetzt `inline_returning` oder `inline_cast` sein. `source` enthält die maßgebliche Rückgabedeklaration beziehungsweise den CAST-Ausdruck; `inlineDeclaration` enthält zusätzlich die vollständige originale DATA-Anweisung mit Datei und Zeilen. Trace-Ausgabe und Inventar offener Referenzen zeigen beide Belege. Die globale Quellenvalidierung prüft beide getrennt; ein negatives Fixture mit falscher Inline-Zeile muss scheitern.

18 Fälle in `test/abap-inline-references.test.ts` sichern Ableitung, Namensräume, Alias-/Basismethoden, Klassikaufrufe, Konstruktorverwendung, gleiche Anweisung, Deklarationsreihenfolge, Grenzen und gespeicherten MCP-Refresh nach Änderung der Rückgabesignatur ab. Im unveränderten Pilot-Export werden sechs Stellen von LCL_COMPARE=>COMPARE_PERNR aufgelöst, alle aus der Inline-Deklaration in Zeile 436 und dem Vertrag von BUILD_EXTRACTOR in 236–238. Die Methoden sind RUN_SIMULATION, IMPORT_LOG, EXPAND_FULL_LOG, GET_TEXT an zwei Stellen und GET_MESSAGES. Daraus entstehen fünf zusätzliche Kanten: 701 Knoten, 2.162 Kanten, 983 offene Referenzen. Alle vorherigen Knoten, Kanten und Aufrufbelege sowie alle verbleibenden Referenzen sind unverändert erhalten. Bericht: local/pilot16-vs-pilot15.json. Kein neuer CE1-Abgleich.
