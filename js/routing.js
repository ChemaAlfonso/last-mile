// Offline routing engine — A* over the OSM-derived comarca road graph.
//
// Loaded as a plain script sharing the global scope (no bundler). The graph
// object (data/graph-comarca.json, already parsed) is handed in by the caller;
// this file never fetches, touches the DOM, or logs in normal operation.
//
// Public surface (frozen — the UI codes against these):
//   initRoutingGraph(graphJson) -> undefined
//   routingReady()              -> boolean
//   computeRoute(fromLat, fromLng, toLat, toLng) -> route | null
//   nearestOnRoute(route, lat, lng) -> { distM, pointIndex }
//
// See docs/offline-routing.md for the graph format contract.

;(function () {
	'use strict'

	// --- Tunables ---------------------------------------------------------
	const EXPECTED_FORMAT = 'lastmile-routing-graph'
	// v1 has no turn restrictions; v2 adds the `restrictions` table. Both are
	// accepted so an updated app shell can still open a not-yet-rebuilt v1 graph
	// left in a driver's IndexedDB during the deploy-transition window.
	const SUPPORTED_VERSIONS = [1, 2]

	const EARTH_R = 6371000 // metres, mean radius for haversine
	const M_PER_DEG_LAT = 111320 // metres per degree of latitude (local-plane approx)

	// Snapping grid: cell side in degrees. ~0.003 deg ≈ 330 m lat / 260 m lng
	// here, giving a couple dozen nodes per cell in this comarca.
	const CELL_DEG = 0.003
	const GRID_STRIDE = 100000 // > max cell index on either axis; packs (gx,gy) into one key
	const SNAP_CAP_M = 500 // a place farther than this from any road is unroutable

	// Turn classification thresholds (absolute bearing change, degrees).
	// Below TURN_MIN the geometry is "straight" and emits no maneuver.
	const TURN_MIN = 25
	const SLIGHT_MAX = 60
	const TURN_MAX = 120

	// A node only becomes a maneuver point when it is a real junction. Pass-through
	// geometry vertices (degree 2) are where a road merely bends — the driver just
	// follows it, so instructing there would be noise on the many winding caminos.
	const JUNCTION_MIN_DEGREE = 3

	// Sharp-reversal (U-turn) penalty. The v1 graph carries no OSM turn restrictions,
	// so a 180° hairpin between the two parallel oneway ways of a dual carriageway
	// (the N-340 median through Crevillent) is data-legal and cost-free — the router
	// happily drives down one carriageway and doubles back up the other. Charging a
	// flat 90 s for any near-reversal makes an around-the-block detour cheaper, while
	// still ALLOWING a genuine dead-end cul-de-sac U-turn (penalised, never forbidden).
	// The penalty only ADDS to edge cost, so the straight-line, penalty-free A*
	// heuristic remains an admissible lower bound.
	const REVERSAL_PENALTY_CS = 9000 // centiseconds (90 s)
	const REVERSAL_MIN_DEG = 150 // heading change at/above which a turn is treated as a reversal

	// --- Graph state (private) -------------------------------------------
	let sourceRef = null // identity of the last graph object → idempotency
	let ready = false

	let NN = 0
	let nodesLat = null // Float64Array
	let nodesLng = null

	let edgesCost = null // per-edge columns, referenced from the JSON
	let edgesCls = null
	let edgesName = null
	let names = null

	// CSR directed adjacency. A "directed edge" is identified by its CSR index p
	// (0..D-1); it is also an A* search state (see astar).
	let DD = 0 // directed-edge count (length of the adj* arrays)
	let adjHead = null // Int32Array(NN+1)
	let adjTo = null // Int32Array(D) — head node of directed edge p
	let adjFrom = null // Int32Array(D) — tail node of directed edge p (for turn geometry)
	let adjCost = null // Int32Array(D)
	let adjEdge = null // Int32Array(D) — undirected edge column index behind directed edge p

	let degU = null // Uint16Array(NN) — undirected degree, for junction detection
	let inScc = null // Uint8Array(NN) — membership of the largest SCC

	let grid = null // Map<number, Int32Array> — SCC nodes bucketed by cell
	let bboxS = 0
	let bboxW = 0

	let maxSpeedMs = 0 // fastest class in the speed table, for the A* heuristic

	// Turn restrictions: banned (via node, from undirected-edge, to undirected-edge)
	// transitions. Indexed by via node → Set of packed (from,to) keys for O(1) lookup.
	let restrictionsByVia = null // Map<number, Set<number>>
	let hasRestrictions = false
	let ftStride = 1 // packing stride for (from,to) → from*ftStride + to (stays < 2^53)

	// A* working state over directed-edge states, kept persistent and stamped by
	// generation to avoid clearing D-length arrays on every query.
	let gScoreE = null // Float64Array(D)
	let cameStateE = null // Int32Array(D) — predecessor directed-edge state, or -1 at start
	let seenGenE = null // Int32Array(D) — gScoreE valid only when seenGenE[p] === gen
	let closedGenE = null // Int32Array(D)
	let gen = 0

	// --- Geometry helpers -------------------------------------------------
	function toRad(d) {
		return (d * Math.PI) / 180
	}

	function haversine(lat1, lng1, lat2, lng2) {
		const dLat = toRad(lat2 - lat1)
		const dLng = toRad(lng2 - lng1)
		const s1 = Math.sin(dLat / 2)
		const s2 = Math.sin(dLng / 2)
		const a = s1 * s1 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2
		return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)))
	}

	// Initial bearing from point 1 to point 2, in degrees (-180..180, clockwise).
	function bearing(lat1, lng1, lat2, lng2) {
		const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2))
		const x =
			Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
			Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1))
		return (Math.atan2(y, x) * 180) / Math.PI
	}

	// --- Decode + build ---------------------------------------------------
	function decodeNodes(g) {
		const S = g.coordScale
		const dlat = g.nodes.dlat
		const dlng = g.nodes.dlng
		NN = dlat.length
		nodesLat = new Float64Array(NN)
		nodesLng = new Float64Array(NN)
		let la = 0
		let lo = 0
		for (let i = 0; i < NN; i++) {
			la += dlat[i]
			lo += dlng[i]
			nodesLat[i] = la / S
			nodesLng[i] = lo / S
		}
	}

	// Decode edge endpoints and build the CSR directed adjacency plus the
	// undirected degree count in a single set of passes.
	function buildAdjacency(g) {
		const fromDelta = g.edges.fromDelta
		const toRel = g.edges.toRel
		const dir = g.edges.dir
		edgesCost = g.edges.cost
		edgesCls = g.edges.cls
		edgesName = g.edges.name
		const EE = fromDelta.length

		const a = new Int32Array(EE)
		const b = new Int32Array(EE)
		let ai = 0
		for (let e = 0; e < EE; e++) {
			ai += fromDelta[e]
			a[e] = ai
			b[e] = ai + toRel[e]
		}

		degU = new Uint16Array(NN)
		const outDeg = new Int32Array(NN) // directed out-degree per node
		for (let e = 0; e < EE; e++) {
			outDeg[a[e]]++
			degU[a[e]]++
			degU[b[e]]++
			if (dir[e] === 0) outDeg[b[e]]++
		}

		adjHead = new Int32Array(NN + 1)
		for (let i = 0; i < NN; i++) adjHead[i + 1] = adjHead[i] + outDeg[i]
		const D = adjHead[NN]
		DD = D
		adjTo = new Int32Array(D)
		adjFrom = new Int32Array(D)
		adjCost = new Int32Array(D)
		adjEdge = new Int32Array(D)

		const cursor = new Int32Array(NN) // fill offset within each node's slice
		for (let e = 0; e < EE; e++) {
			const na = a[e]
			const nb = b[e]
			const c = edgesCost[e]
			let p = adjHead[na] + cursor[na]++
			adjTo[p] = nb
			adjFrom[p] = na
			adjCost[p] = c
			adjEdge[p] = e
			if (dir[e] === 0) {
				p = adjHead[nb] + cursor[nb]++
				adjTo[p] = na
				adjFrom[p] = nb
				adjCost[p] = c
				adjEdge[p] = e
			}
		}
	}

	// Index the turn-restriction table (v2). v1 graphs have none — leaving the
	// map empty makes hasRestrictions false and skips all lookups in the hot loop.
	function buildRestrictions(g, edgeCount) {
		restrictionsByVia = new Map()
		hasRestrictions = false
		ftStride = edgeCount + 1 // from,to < edgeCount → packed key stays a safe integer
		const r = g.restrictions
		if (!r || !r.via || r.via.length === 0) return
		const via = r.via
		const from = r.from
		const to = r.to
		for (let k = 0; k < via.length; k++) {
			let set = restrictionsByVia.get(via[k])
			if (!set) {
				set = new Set()
				restrictionsByVia.set(via[k], set)
			}
			set.add(from[k] * ftStride + to[k])
		}
		hasRestrictions = restrictionsByVia.size > 0
	}

	// Iterative Tarjan over the directed adjacency; marks membership of the
	// single largest strongly connected component so snapping never lands on an
	// orphan island (dead-end loops, oneway traps, bbox-clipped stubs).
	function computeLargestScc() {
		const index = new Int32Array(NN).fill(-1)
		const lowlink = new Int32Array(NN)
		const onStack = new Uint8Array(NN)
		const compId = new Int32Array(NN).fill(-1)
		const iter = new Int32Array(NN) // next adjacency offset per node
		const callStack = new Int32Array(NN) // explicit DFS stack (bounded by NN)
		const tarjan = new Int32Array(NN) // Tarjan's component stack
		let tarjanTop = 0
		let idx = 0
		let comp = 0
		const compSize = []

		for (let s = 0; s < NN; s++) {
			if (index[s] !== -1) continue
			let csTop = 0
			callStack[csTop++] = s
			index[s] = lowlink[s] = idx++
			onStack[s] = 1
			tarjan[tarjanTop++] = s
			iter[s] = adjHead[s]

			while (csTop > 0) {
				const v = callStack[csTop - 1]
				let recursed = false
				let e = iter[v]
				const end = adjHead[v + 1]
				while (e < end) {
					const w = adjTo[e]
					if (index[w] === -1) {
						iter[v] = e + 1
						callStack[csTop++] = w
						index[w] = lowlink[w] = idx++
						onStack[w] = 1
						tarjan[tarjanTop++] = w
						iter[w] = adjHead[w]
						recursed = true
						break
					}
					if (onStack[w] && index[w] < lowlink[v]) lowlink[v] = index[w]
					e++
					iter[v] = e
				}
				if (recursed) continue

				if (lowlink[v] === index[v]) {
					let size = 0
					let w = -1
					do {
						w = tarjan[--tarjanTop]
						onStack[w] = 0
						compId[w] = comp
						size++
					} while (w !== v)
					compSize[comp] = size
					comp++
				}
				csTop--
				if (csTop > 0) {
					const p = callStack[csTop - 1]
					if (lowlink[v] < lowlink[p]) lowlink[p] = lowlink[v]
				}
			}
		}

		let biggest = 0
		for (let c = 1; c < compSize.length; c++) if (compSize[c] > compSize[biggest]) biggest = c
		inScc = new Uint8Array(NN)
		for (let i = 0; i < NN; i++) if (compId[i] === biggest) inScc[i] = 1
	}

	// Spatial grid over the main-component nodes only, so a snap can never pick an
	// orphan-island node.
	function buildGrid() {
		const counts = new Map()
		for (let i = 0; i < NN; i++) {
			if (!inScc[i]) continue
			const key = cellKey(nodesLat[i], nodesLng[i])
			counts.set(key, (counts.get(key) || 0) + 1)
		}
		grid = new Map()
		const fill = new Map()
		for (const [key, n] of counts) {
			grid.set(key, new Int32Array(n))
			fill.set(key, 0)
		}
		for (let i = 0; i < NN; i++) {
			if (!inScc[i]) continue
			const key = cellKey(nodesLat[i], nodesLng[i])
			const arr = grid.get(key)
			arr[fill.get(key)] = i
			fill.set(key, fill.get(key) + 1)
		}
	}

	function cellKey(lat, lng) {
		const gx = Math.floor((lng - bboxW) / CELL_DEG)
		const gy = Math.floor((lat - bboxS) / CELL_DEG)
		return gx * GRID_STRIDE + gy
	}

	// --- Snapping ---------------------------------------------------------
	// Nearest main-component node to (lat,lng) via expanding grid rings, capped
	// at SNAP_CAP_M. Returns { node, dist } or null.
	function snap(lat, lng) {
		const gx = Math.floor((lng - bboxW) / CELL_DEG)
		const gy = Math.floor((lat - bboxS) / CELL_DEG)
		const cosLat = Math.cos(toRad(lat))
		// Conservative metres-per-cell (smaller of lat/lng) → never stops a ring early.
		const cellM = CELL_DEG * M_PER_DEG_LAT * Math.min(1, Math.max(0.01, cosLat))
		const maxRing = Math.ceil(SNAP_CAP_M / cellM) + 1

		let best = -1
		let bestD = Infinity
		for (let r = 0; r <= maxRing; r++) {
			// Any node in ring r is at least (r-1) cell-widths away; stop once that
			// lower bound exceeds the best distance found so far.
			if (best >= 0 && (r - 1) * cellM > bestD) break
			for (let dx = -r; dx <= r; dx++) {
				for (let dy = -r; dy <= r; dy++) {
					if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue // ring perimeter only
					const cx = gx + dx
					const cy = gy + dy
					if (cx < 0 || cy < 0) continue
					const bucket = grid.get(cx * GRID_STRIDE + cy)
					if (!bucket) continue
					for (let k = 0; k < bucket.length; k++) {
						const node = bucket[k]
						const d = haversine(lat, lng, nodesLat[node], nodesLng[node])
						if (d < bestD) {
							bestD = d
							best = node
						}
					}
				}
			}
		}
		if (best < 0 || bestD > SNAP_CAP_M) return null
		return { node: best, dist: bestD }
	}

	// --- A* ---------------------------------------------------------------
	// Admissible heuristic: straight-line time at the fastest class, in
	// centiseconds (the edge-cost unit).
	function heuristic(node, goalLat, goalLng) {
		return (haversine(nodesLat[node], nodesLng[node], goalLat, goalLng) / maxSpeedMs) * 100
	}

	// Binary min-heap keyed by f-value, storing (node, f). Stale entries left
	// behind by a decrease-key are skipped on pop via the closed stamp.
	function makeHeap() {
		const node = []
		const f = []
		function up(i) {
			while (i > 0) {
				const p = (i - 1) >> 1
				if (f[p] <= f[i]) break
				swap(i, p)
				i = p
			}
		}
		function down(i) {
			const n = node.length
			for (;;) {
				const l = 2 * i + 1
				const r = l + 1
				let s = i
				if (l < n && f[l] < f[s]) s = l
				if (r < n && f[r] < f[s]) s = r
				if (s === i) break
				swap(i, s)
				i = s
			}
		}
		function swap(i, j) {
			const tn = node[i]
			node[i] = node[j]
			node[j] = tn
			const tf = f[i]
			f[i] = f[j]
			f[j] = tf
		}
		return {
			get size() {
				return node.length
			},
			push(nd, fv) {
				node.push(nd)
				f.push(fv)
				up(node.length - 1)
			},
			pop() {
				const topNode = node[0]
				const last = node.length - 1
				node[0] = node[last]
				f[0] = f[last]
				node.pop()
				f.pop()
				if (node.length > 0) down(0)
				return topNode
			}
		}
	}

	// Edge-based A*. A search STATE is a directed edge (its CSR index p) — "just
	// traversed edge p, now standing at its head node". Modelling the arriving
	// edge, not just the node, is what makes turn restrictions and the reversal
	// penalty EXACT: both are properties of the (incoming edge, outgoing edge)
	// pair at the via node, which a single g-score per node cannot represent. A
	// node-based search fixes one predecessor per node and can therefore wrongly
	// report "no route" at a restricted junction (its only settled approach forbids
	// the needed onward turn while a costlier approach would allow it). Edge states
	// cost ~2x memory (arrays sized by directed-edge count) and expand a few times
	// more states — still well inside budget on this graph.
	//
	// Returns { nodes:[...ids], edges:[...edgeIdx] } or null. edges[i] is the
	// undirected edge joining nodes[i] and nodes[i+1].
	function astar(start, goal) {
		if (start === goal) return { nodes: [start], edges: [] }

		gen++
		const goalLat = nodesLat[goal]
		const goalLng = nodesLng[goal]
		const heap = makeHeap()

		// Seed with every directed edge leaving the start node. The depart hop has
		// no incoming edge, so it carries neither a reversal penalty nor a restriction.
		const startEnd = adjHead[start + 1]
		for (let p = adjHead[start]; p < startEnd; p++) {
			gScoreE[p] = adjCost[p]
			seenGenE[p] = gen
			cameStateE[p] = -1
			heap.push(p, adjCost[p] + heuristic(adjTo[p], goalLat, goalLng))
		}

		let finalState = -1
		while (heap.size > 0) {
			const p = heap.pop()
			if (closedGenE[p] === gen) continue // stale duplicate
			closedGenE[p] = gen
			const u = adjTo[p] // node we are standing at, having arrived via edge p
			if (u === goal) {
				finalState = p
				break
			}
			const gp = gScoreE[p]
			const uLat = nodesLat[u]
			const uLng = nodesLng[u]
			const fromEdge = adjEdge[p]
			const inB = bearing(nodesLat[adjFrom[p]], nodesLng[adjFrom[p]], uLat, uLng)
			const banned = hasRestrictions ? restrictionsByVia.get(u) : undefined
			const end = adjHead[u + 1]
			for (let q = adjHead[u]; q < end; q++) {
				if (closedGenE[q] === gen) continue
				// Hard turn restriction: never emit a banned (via, from, to) transition.
				if (banned !== undefined && banned.has(fromEdge * ftStride + adjEdge[q])) continue
				let turn = bearing(uLat, uLng, nodesLat[adjTo[q]], nodesLng[adjTo[q]]) - inB
				while (turn > 180) turn -= 360
				while (turn < -180) turn += 360
				const penalty = Math.abs(turn) >= REVERSAL_MIN_DEG ? REVERSAL_PENALTY_CS : 0
				const tentative = gp + adjCost[q] + penalty
				if (seenGenE[q] !== gen || tentative < gScoreE[q]) {
					gScoreE[q] = tentative
					seenGenE[q] = gen
					cameStateE[q] = p
					heap.push(q, tentative + heuristic(adjTo[q], goalLat, goalLng))
				}
			}
		}

		if (finalState === -1) return null // goal never reached → unreachable

		// Walk predecessors back to a seed (cameState -1), then emit node/edge lists.
		const dedges = []
		let s = finalState
		while (s !== -1) {
			dedges.push(s)
			s = cameStateE[s]
		}
		dedges.reverse()
		const nodes = [adjFrom[dedges[0]]] // tail of the first hop == start
		const edges = []
		for (let i = 0; i < dedges.length; i++) {
			nodes.push(adjTo[dedges[i]])
			edges.push(adjEdge[dedges[i]])
		}
		return { nodes, edges }
	}

	// --- Steps / guidance -------------------------------------------------
	function nameOfEdge(edgeIdx) {
		const ni = edgesName[edgeIdx]
		return ni === -1 ? null : names[ni]
	}

	function classifyTurn(delta) {
		const a = Math.abs(delta)
		const side = delta > 0 ? 'right' : 'left'
		if (a < SLIGHT_MAX) return 'slight-' + side
		if (a < TURN_MAX) return side
		return 'sharp-' + side
	}

	// Terse maneuver list: depart, a turn at each junction where the driver
	// actually changes heading, arrive. distM is the run length to the next step.
	function buildSteps(points, edges, cumDist, pathNodes) {
		const L = points.length
		if (L < 2) {
			return [
				{ at: 0, type: 'depart', name: null, distM: 0 },
				{ at: 0, type: 'arrive', name: null, distM: 0 }
			]
		}

		const steps = [{ at: 0, type: 'depart', name: nameOfEdge(edges[0]), distM: 0 }]
		for (let k = 1; k <= L - 2; k++) {
			if (degU[pathNodes[k]] < JUNCTION_MIN_DEGREE) continue
			const inB = bearing(points[k - 1][0], points[k - 1][1], points[k][0], points[k][1])
			const outB = bearing(points[k][0], points[k][1], points[k + 1][0], points[k + 1][1])
			let d = outB - inB
			while (d > 180) d -= 360
			while (d < -180) d += 360
			if (Math.abs(d) < TURN_MIN) continue
			steps.push({ at: k, type: classifyTurn(d), name: nameOfEdge(edges[k]), distM: 0 })
		}
		steps.push({ at: L - 1, type: 'arrive', name: null, distM: 0 })

		for (let i = 0; i < steps.length - 1; i++) {
			steps[i].distM = cumDist[steps[i + 1].at] - cumDist[steps[i].at]
		}
		return steps
	}

	// --- Public API -------------------------------------------------------
	function initRoutingGraph(graphJson) {
		if (graphJson === sourceRef) return // idempotent no-op on the same object
		if (
			!graphJson ||
			graphJson.format !== EXPECTED_FORMAT ||
			SUPPORTED_VERSIONS.indexOf(graphJson.formatVersion) === -1
		) {
			throw new Error(
				'initRoutingGraph: expected ' + EXPECTED_FORMAT + ' v' + SUPPORTED_VERSIONS.join('/') + ', got ' +
					(graphJson && graphJson.format) + ' v' + (graphJson && graphJson.formatVersion)
			)
		}

		ready = false
		names = graphJson.names
		bboxS = graphJson.bbox[0]
		bboxW = graphJson.bbox[1]

		let maxKmh = 0
		for (const k in graphJson.speedTable) if (graphJson.speedTable[k] > maxKmh) maxKmh = graphJson.speedTable[k]
		maxSpeedMs = maxKmh / 3.6

		decodeNodes(graphJson)
		buildAdjacency(graphJson)
		buildRestrictions(graphJson, graphJson.edges.fromDelta.length)
		computeLargestScc()
		buildGrid()

		gScoreE = new Float64Array(DD)
		cameStateE = new Int32Array(DD)
		seenGenE = new Int32Array(DD) // 0 = unseen; gen starts at 1 on first query
		closedGenE = new Int32Array(DD)
		gen = 0

		sourceRef = graphJson
		ready = true
	}

	function routingReady() {
		return ready
	}

	function computeRoute(fromLat, fromLng, toLat, toLng) {
		if (!ready) return null
		const s = snap(fromLat, fromLng)
		const t = snap(toLat, toLng)
		if (!s || !t) return null

		const path = astar(s.node, t.node)
		if (!path) return null

		const pn = path.nodes
		const L = pn.length
		const points = new Array(L)
		for (let i = 0; i < L; i++) points[i] = [nodesLat[pn[i]], nodesLng[pn[i]]]

		const cumDist = new Float64Array(L)
		for (let i = 1; i < L; i++) {
			cumDist[i] = cumDist[i - 1] + haversine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1])
		}

		let durationS = 0
		for (let i = 0; i < path.edges.length; i++) durationS += edgesCost[path.edges[i]]
		durationS /= 100

		return {
			points,
			distanceM: L > 0 ? cumDist[L - 1] : 0,
			durationS,
			startSnap: { lat: nodesLat[s.node], lng: nodesLng[s.node], distM: s.dist },
			endSnap: { lat: nodesLat[t.node], lng: nodesLng[t.node], distM: t.dist },
			steps: buildSteps(points, path.edges, cumDist, pn)
		}
	}

	// Distance (metres) from (lat,lng) to the nearest point on the route
	// polyline, projecting onto segments; pointIndex is the segment start.
	function nearestOnRoute(route, lat, lng) {
		const pts = route.points
		if (!pts || pts.length === 0) return { distM: Infinity, pointIndex: 0 }
		if (pts.length === 1) {
			return { distM: haversine(lat, lng, pts[0][0], pts[0][1]), pointIndex: 0 }
		}

		// Local equirectangular metres relative to the query point (segments are
		// short, so the flat-plane approximation is accurate here).
		const mLat = M_PER_DEG_LAT
		const mLng = M_PER_DEG_LAT * Math.cos(toRad(lat))
		let bestD = Infinity
		let bestIdx = 0
		for (let i = 0; i < pts.length - 1; i++) {
			const ax = (pts[i][1] - lng) * mLng
			const ay = (pts[i][0] - lat) * mLat
			const bx = (pts[i + 1][1] - lng) * mLng
			const by = (pts[i + 1][0] - lat) * mLat
			const dx = bx - ax
			const dy = by - ay
			const len2 = dx * dx + dy * dy
			let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0
			if (t < 0) t = 0
			else if (t > 1) t = 1
			const ex = ax + t * dx
			const ey = ay + t * dy
			const d = Math.sqrt(ex * ex + ey * ey)
			if (d < bestD) {
				bestD = d
				bestIdx = i
			}
		}
		return { distM: bestD, pointIndex: bestIdx }
	}

	const scope = typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this
	scope.initRoutingGraph = initRoutingGraph
	scope.routingReady = routingReady
	scope.computeRoute = computeRoute
	scope.nearestOnRoute = nearestOnRoute
})()
