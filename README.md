<p align="center">
	<img src="assets/og.png" alt="Last Mile — Direcciones rurales que no aparecen en el mapa" width="100%" />
</p>

<h1 align="center">Last Mile</h1>

<p align="center">
	<strong>Direcciones rurales que no aparecen en el mapa.</strong><br />
	PWA offline para repartidores en zonas de campo y diseminados.<br />
	<a href="https://lastmile.chemaalfonso.com">lastmile.chemaalfonso.com</a>
</p>

<p align="center">
	<img src="https://img.shields.io/badge/vanilla-JS-f7df1e?labelColor=1a1714" alt="Vanilla JS" />
	<img src="https://img.shields.io/badge/dependencias-0-e8500a?labelColor=1a1714" alt="Cero dependencias" />
	<img src="https://img.shields.io/badge/PWA-instalable-e8500a?labelColor=1a1714" alt="PWA instalable" />
	<img src="https://img.shields.io/badge/datos-Catastro-2f7d4f?labelColor=1a1714" alt="Datos del Catastro" />
	<img src="https://img.shields.io/badge/licencia-MIT-1a1714" alt="Licencia MIT" />
</p>

---

## El problema

Miles de casas de campo tienen dirección oficial — *"Partida El Boch 100"*, *"Camino del Almajal 12"* — pero **no existen para Google Maps ni para ningún GPS comercial**. Quien reparte en estas zonas pierde tiempo en cada entrega, y los servicios de emergencia no encuentran las viviendas.

Last Mile lo resuelve dos veces:

1. **Base oficial**: incluye las direcciones rurales del [Catastro](https://www.catastro.hacienda.gob.es/webinspire/index.html) (datos abiertos) por población, con sus coordenadas exactas — partidas, diseminados, caminos, veredas y barrios de huerta que ningún mapa comercial conoce.
2. **Base personal**: cuando llegas a un sitio que ni el Catastro clava, fijas el punto exacto con el GPS o tocando el mapa, le pones nombre y notas para llegar ("portón verde tras la curva") y queda guardado para la próxima.

## Características

- 🔍 **Búsqueda pensada para el campo**: por palabras y sin acentos, sobre tus direcciones, la base oficial y OpenStreetMap, con resultados agrupados por partida y filtro por número.
- 🗂️ **Navegador de partidas**: explora las partidas de tu zona y llega hasta la casa tocando, sin saber qué teclear.
- 🏷️ **Casas sin número incluidas**: cada vivienda S/N entra con su identificador de parcela, buscable como se diría sobre el terreno.
- 📍 **Punto exacto, no aproximado**: fija por GPS o tocando el mapa, y afina arrastrando el pin.
- ✏️ **Todo es corregible**: si el Catastro tiene un punto mal, edítalo — tus correcciones sobreviven a las actualizaciones y viajan en tus copias.
- 📴 **Offline de verdad, mapa incluido**: al descargar tu zona se instala también el mapa de la comarca — app, puntos y mapa funcionan sin cobertura.
- 🚗 **Ruta sin conexión**: guiado giro a giro sin red hasta la puerta, calculado en el propio móvil. Complementa al botón de ruta de Google, no lo sustituye.
- 🤝 **Compartir entre repartidores**: pasa tus puntos y correcciones a un compañero; al importar, lo tuyo siempre prevalece.
- 🔒 **Privacidad total**: sin servidor ni cuentas — tus direcciones viven solo en tu dispositivo, con copia de seguridad exportable.
- 📱 **Instalable**: PWA a pantalla completa, arranque instantáneo y aviso de "Actualizar" cuando hay datos nuevos.
- 🗺️ **Escala**: decenas de miles de puntos con mapa fluido y búsqueda instantánea.

## Poblaciones incluidas

Catálogo actual (~19.200 puntos oficiales, Vega Baja y Baix Vinalopó). Cada usuario descarga solo su zona desde Ajustes:

| Población | Puntos | Población | Puntos |
|---|---:|---|---:|
| Orihuela | 8.261 | Almoradí | 943 |
| Crevillent | 3.880 | Cox | 255 |
| Albatera | 1.641 | Granja de Rocamora | 145 |
| Callosa de Segura | 1.519 | San Isidro | 105 |
| Catral | 1.389 | Dolores | 1.037 |

### Añadir una población

```bash
python3 tools/build_dataset.py <código_municipio> <id> "<Nombre>"
# ejemplo:
python3 tools/build_dataset.py 03059 crevillent Crevillent
```

El script descarga los datos abiertos del Catastro para ese municipio, los limpia y actualiza el catálogo — las poblaciones ya descargadas por los usuarios muestran "Actualizar" automáticamente. Guía completa en [`docs/datasets.md`](docs/datasets.md).

## Desarrollo

Sin build, sin bundler, sin npm — ficheros estáticos y un directorio de datos:

```bash
python3 tools/dev_server.py 8000
# → http://localhost:8000
```

> Sirve siempre por HTTP: abrir `index.html` como archivo rompe el service worker, IndexedDB y la geolocalización.

Documentación:

- [`docs/datasets.md`](docs/datasets.md) — cómo se construyen los datasets del Catastro
- [`docs/offline-map.md`](docs/offline-map.md) — mapa offline (generación, servido y atribución)
- [`docs/offline-routing.md`](docs/offline-routing.md) — grafo y motor de la "Ruta sin conexión"
- [`docs/growth.md`](docs/growth.md) — añadir poblaciones y zonas nuevas
- [`CLAUDE.md`](CLAUDE.md) — arquitectura y convenciones del código

## Créditos y atribuciones

- Direcciones rurales: [Dirección General del Catastro](https://www.catastro.hacienda.gob.es/webinspire/index.html) (servicios INSPIRE, datos abiertos).
- Mapa: [Leaflet](https://leafletjs.com) © colaboradores de [OpenStreetMap](https://www.openstreetmap.org/copyright).
- Geocodificación: [Nominatim](https://nominatim.org) (respetando su política de uso).
- Tipografía: [Barlow](https://fonts.google.com/specimen/Barlow) / Barlow Condensed.

## Licencia

[MIT](LICENSE.md) — úsala, cópiala, modifícala y compártela libremente, conservando el aviso de copyright y atribución.

---

<p align="center">
	Desarrollado por <a href="https://krakenlabsweb.com"><strong>Chema Alfonso · Kraken Labs Web</strong></a>
</p>
