/**
 * spanish.dictionary.ts
 * Pure domain foundational Spanish academic vocabulary for SpellEngine.
 */

const WORD_DATA = `
el la los las un una unos unas lo al del y e o u pero mas sino aunque porque pues como cuando donde mientras si a
ante bajo con contra de desde durante en entre hacia hasta mediante para por según sin sobre tras yo tú él ella
ello nosotros vosotros ellos ellas mi mis tu tus su sus nuestro nuestra nuestros nuestras este esta estos estas
esto ese esa esos esas eso aquel aquella aquellos aquellas que quien quienes cual cuales cuyo cuya no sí más menos
muy bien mal también tampoco todo toda todos todas otro otra otros otras mismo misma mismos mismas ser es son era
eran fue fueron sido será estar está están estaba estuvieron estado haber ha han había hay tener tiene tienen hacer
hace hacen poder puede pueden resumen introducción método métodos metodología resultado resultados discusión
conclusión conclusiones referencias bibliografía apéndice ecuación ecuaciones figura figuras tabla tablas sección
capítulo teorema lema corolario demostración prueba definición hipótesis modelo modelos modelado algoritmo
algoritmos análisis estudio estudios investigación investigaciones experimento experimentos experimental teórico
teórica empírico empírica numérico numérica estadística estadístico probabilidad distribución varianz varianza
promedio media desviación datos muestra parámetro parámetros variable variables función funciones sistema sistemas
red redes aprendizaje profundo automático inteligencia artificial evaluación rendimiento precisión exactitud
enfoque enfoques problema probleme problemas solución soluciones aplicación aplicaciones universidad instituto
laboratorio departamento facultad autor autores artículo tesis informe además asimismo embargo tanto
consecuentemente específicamente particularmente finalmente
`;

export const SPANISH_WORDS: readonly string[] = WORD_DATA.trim().split(/\s+/);

export const SPANISH_ACADEMIC_WORDS = SPANISH_WORDS;
