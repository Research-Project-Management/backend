/**
 * german.dictionary.ts
 * Pure domain foundational German academic vocabulary for SpellEngine.
 */

const WORD_DATA = `
der die das den dem des ein eine einer eines einem einen und oder aber denn sondern doch jedoch in im an am auf aus
bei mit nach seit von vom zu zum zur für ohne um über unter vor hinter neben zwischen durch gegen während wegen
trotz innerhalb außerhalb ich du er sie es wir ihr mein dein sein unser euer dieser diese dieses diesen diesem
jener jene jenes welcher welche welches nicht kein keine keinen keinem keiner auch noch schon nur sehr mehr weniger
als wie wenn weil dass ob obwohl damit ist sind war waren gewesen wird werden wurde wurden geworden haben hat hatte
hatten gehabt können kann müssen muss sollen soll zusammenfassung einleitung methode methoden methodik ergebnis
ergebnisse diskussion fazit schlussfolgerung literatur referenzen anhang gleichung gleichungen abbildung
abbildungen tabelle tabellen abschnitt kapitel satz theorem lemma korollar beweis definition hypothese hypothesen
modell modelle modellierung algorithmus algorithmen analyse untersuchung studie studien forschung experiment
experimente experimentell theoretisch empirisch numerisch statistik statistisch wahrscheinlichkeit verteilung
varianz mittelwert standardabweichung daten stichprobe parameter variable variablen funktion funktionen system
systeme netzwerk netzwerke maschinelles lernen künstliche intelligenz auswertung bewertung leistung genauigkeit
ansatz ansätze problem probleme lösung lösungen anwendung anwendungen universität institut fakultät lehrstuhl autor
autoren arbeit dissertation bericht allerdings daher deshalb somit folglich insbesondere außerdem zusätzlich
beispielsweise
`;

export const GERMAN_WORDS: readonly string[] = WORD_DATA.trim().split(/\s+/);

export const GERMAN_ACADEMIC_WORDS = GERMAN_WORDS;
