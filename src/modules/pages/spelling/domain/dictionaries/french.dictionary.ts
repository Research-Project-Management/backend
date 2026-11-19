/**
 * french.dictionary.ts
 * Pure domain foundational French academic vocabulary for SpellEngine.
 */

const WORD_DATA = `
le la les un une des du de au aux et ou mais donc or ni car dans sur sous avec sans pour par en vers chez entre
contre ce cet cette ces mon ton son notre votre leur leurs mes tes ses nos vos je tu il elle on nous vous ils elles
qui que quoi dont où lequel laquelle lesquels lesquelles ne pas plus moins très bien mal aussi comme tout tous
toute toutes autre autres même mêmes être est sont était étaient été sera seront avoir a ont avait avaient eu aura
auront faire fait font peut peuvent doit doivent résumé introduction méthode méthodes méthodologie résultat
résultats discussion conclusion références bibliographie annexe équation équations figure figures tableau tableaux
section chapitre théorème lemme corollaire démonstration preuve définition hypothèse hypothèses modèle modèles
modélisation algorithme algorithmes analyse étude études recherche recherches expérience expériences expérimental
expérimentale théorique empirique numérique statistique statistiques probabilité distribution variance moyenne
écart données échantillon paramètre paramètres variable variables fonction fonctions système systèmes réseau
réseaux apprentissage profond automatique intelligence artificielle évaluation performance performances précision
approche approches problème problèmes solution solutions application applications université laboratoire institut
département auteur auteurs article thèse mémoire rapport cependant néanmoins toutefois ainsi notamment
particulièrement également ensuite enfin premièrement deuxièmement
`;

export const FRENCH_WORDS: readonly string[] = WORD_DATA.trim().split(/\s+/);

export const FRENCH_ACADEMIC_WORDS = FRENCH_WORDS;
