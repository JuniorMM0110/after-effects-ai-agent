# Avances de AE AI

Este espacio muestra el progreso del plugin AE AI para Adobe After Effects. **No es la distribución del instalador**: los paquetes de macOS y Windows y los cambios de desarrollo completos se mantienen separados de esta página pública.

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
