# Avances de AE AI

Este espacio muestra el progreso del plugin AE AI para Adobe After Effects. **No es la distribución del instalador**: los paquetes de macOS y Windows y los cambios de desarrollo completos se mantienen separados de esta página pública.

## 20 de octubre de 2026 — 0.5.4 (análisis visual de animaciones por IA)

- Nuevo flujo de revisión donde la IA **recibe imágenes reales** extraídas de la composición, no solo una ruta de video o métricas de fotogramas.
- Revisión general de toda la línea de tiempo mediante hojas de contacto con marcas de tiempo y revisión concentrada de los segundos que necesitan corrección.
- Cuando la tarea modifica animaciones, AE AI puede inspeccionar estas imágenes, identificar problemas respaldados por evidencias visuales y solicitar ajustes agrupados en After Effects, con una segunda revisión localizada.
- Se puede desactivar la revisión automática para reducir consumo. El número de imágenes y las iteraciones se limitan para evitar desperdicio de tokens.

**Importante:** las secuencias de fotogramas permiten que la IA compare visualmente estados y cambios, pero **todavía no equivalen a que el modelo vea un video continuo a FPS completos**. La detección de errores entre las muestras o de defectos sutiles de fluidez no está garantizada.

**Estado:** integrado y comprobado con pruebas automatizadas. Falta la validación final del flujo completo con una composición real después de reiniciar After Effects.

## 20 de octubre de 2026 — 0.5.3 (Motion Review de FPS reales)

- Incorporado un segundo modo de previsualización para **generar un clip corto con todos los fotogramas de un tramo**, respetando la frecuencia de la composición (ej. 23,976, 29,97 o 60 fps).
- Conserva la revisión económica por muestreo de fotogramas, útil para evitar tiempos de render y consumo excesivo de recursos.
- Nuevo indicador de progreso, cancelación y límites para revisar hasta 120 fotogramas por solicitud.
- El video generado reproduce el movimiento a sus FPS originales cuando hay FFmpeg disponible. **No es RAM Preview en vivo ni implica que la IA pueda mirar automáticamente toda la secuencia**; el agente sigue contando con indicadores y capturas para su análisis.
- Pruebas automatizadas de fotogramas, comprobación de tasa de salida y tolerancia a errores.

**Estado:** versión experimental, pendiente de validación visual final en After Effects después de recargar el panel. El código completo y los instaladores se mantienen en un repositorio privado.

## 19 de octubre de 2026 — 0.5.2 (mejoras de interfaz)

- Rediseño de la barra de escritura inspirado en interfaces de chat: campo de texto más limpio y acciones agrupadas en la parte inferior.
- Un solo botón **Ejecutar / Detener** que alterna según el estado real del proceso.
- Selección compacta de **modelo y esfuerzo de razonamiento** junto al botón de ejecución.
- El menú `+` reduce su contenido al conservar adjuntos, presets, plantillas y ajustes complementarios.
- Se mantiene el control de contexto y las herramientas de revisión temporal introducidos en 0.5.1.

**Estado:** desarrollo y pruebas; la nueva interfaz debe verificarse visualmente dentro de After Effects después de reiniciar el panel. No se publica todavía una versión instalable para descarga pública.

## 19 de octubre de 2026 — 0.5.1 (pruebas)

- Previsualización temporal de animaciones dentro del panel: reproducción de muestras visuales de pocos segundos.
- Análisis preliminar de cambios de imagen entre fotogramas para señalar segmentos que necesitan revisión.
- Controles para conservar u omitir el contexto reciente del chat entre tareas e iniciar una sesión nueva sin borrar conversaciones anteriores.
- Estadísticas diferenciadas de tokens de entrada nuevos, reutilizados y generados, incluyendo el total registrado en el chat.
- Herramienta de revisión temporal bajo demanda para no aumentar el contexto de herramientas de las tareas habituales.
- Compilaciones de prueba preparadas para macOS Intel, macOS Apple Silicon y Windows x64.

**Estado:** las pruebas automatizadas han pasado. Falta verificar la reproducción desde el panel recién cargado en After Effects y la ejecución de los instaladores en Windows real. La previsualización es muestreada y **todavía no sustituye una reproducción continua a FPS completo**.

## Política de publicación

Los instaladores no se publican aquí. La distribución, las fuentes de trabajo completas y los paquetes privados deben almacenarse en un repositorio **privado independiente**, con acceso restringido. No confundas una rama de GitHub pública con un repositorio privado.
