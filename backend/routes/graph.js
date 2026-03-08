import { getSession } from '../neo4j/driver.js';
import { neo4jToCytoscape } from '../services/graph-transform.js';
import { bulkRiskScores } from '../services/detection.js';
import { detectCommunities } from '../services/community.js';

export default async function graphRoutes(fastify) {
  fastify.get('/graph', async (request, reply) => {
    const limit = parseInt(request.query.limit || '200', 10);
    const coinType = request.query.coin_type || null;
    const address = request.query.address || null;

    const session = getSession();
    try {
      let cypher;
      const params = { limit };

      if (address) {
        // Ego-centered subgraph (1-hop neighborhood)
        cypher = `
          MATCH (center:Wallet {address: $address})-[t:TRANSFER]-(neighbor:Wallet)
          ${coinType ? 'WHERE t.coin_type = $coinType' : ''}
          RETURN center, t, neighbor
          LIMIT toInteger($limit)
        `;
        if (coinType) params.coinType = coinType;
        params.address = address;
      } else if (coinType) {
        // Filter by coin type
        cypher = `
          MATCH (a:Wallet)-[t:TRANSFER]->(b:Wallet)
          WHERE t.coin_type = $coinType
          RETURN a, t, b
          LIMIT toInteger($limit)
        `;
        params.coinType = coinType;
      } else {
        // General subgraph
        cypher = `
          MATCH (a:Wallet)-[t:TRANSFER]->(b:Wallet)
          RETURN a, t, b
          LIMIT toInteger($limit)
        `;
      }

      const result = await session.run(cypher, params);
      const elements = neo4jToCytoscape(result.records);

      // ── Risk scores ─────────────────────────────────────────────────
      const walletAddresses = elements.nodes
        .filter((n) => n.data.nodeType === 'Wallet')
        .map((n) => n.data.label);

      if (walletAddresses.length > 0) {
        const scores = await bulkRiskScores(walletAddresses, session);
        for (const node of elements.nodes) {
          if (node.data.nodeType === 'Wallet') {
            node.data.riskScore = scores[node.data.label] ?? 0;
          }
        }
      }

      // ── Per-node total volume (sum of value_lossless on all edges) ──
      const nodeVolume = new Map();
      for (const edge of elements.edges) {
        const val = parseFloat(edge.data.value_lossless || edge.data.amount || 0);
        if (!isNaN(val)) {
          nodeVolume.set(edge.data.source, (nodeVolume.get(edge.data.source) || 0) + val);
          nodeVolume.set(edge.data.target, (nodeVolume.get(edge.data.target) || 0) + val);
        }
      }

      // ── Log-scaled volume & normalization ───────────────────────────
      // log_volume = log10(total_volume + 1)
      // normalized = (log_volume - min) / (max - min)
      const logVolumes = new Map();
      let logMin = Infinity;
      let logMax = -Infinity;

      for (const node of elements.nodes) {
        const totalVol = nodeVolume.get(node.data.id) || 0;
        const logVol = Math.log10(totalVol + 1);
        logVolumes.set(node.data.id, logVol);
        if (logVol < logMin) logMin = logVol;
        if (logVol > logMax) logMax = logVol;
      }

      const logRange = logMax - logMin || 1; // avoid div-by-zero

      for (const node of elements.nodes) {
        const totalVol = nodeVolume.get(node.data.id) || 0;
        const logVol = logVolumes.get(node.data.id);
        const normalized = (logVol - logMin) / logRange; // 0..1

        node.data.totalVolume = totalVol;
        node.data.logVolume = logVol;
        node.data.normalizedVolume = normalized;
        // Keep value_lossless for backward compat / tooltip display
        node.data.value_lossless = totalVol;
      }

      // ── Edge log-width ──────────────────────────────────────────────
      // width = log10(amount + 1) → then frontend scales to visual range
      for (const edge of elements.edges) {
        const amt = parseFloat(edge.data.amount || 0);
        edge.data.logAmount = Math.log10(amt + 1);
      }

      // ── Community detection (Louvain on subgraph) ───────────────────
      const communities = detectCommunities(elements);
      const clusterSizes = new Map();
      for (const [, cid] of communities) {
        clusterSizes.set(cid, (clusterSizes.get(cid) || 0) + 1);
      }
      for (const node of elements.nodes) {
        node.data.clusterId = communities.get(node.data.id) ?? -1;
      }

      // ── Temporal normalization ──────────────────────────────────────
      // Normalize edge timestamps to [0, 1] for optional animation
      let tsMin = Infinity;
      let tsMax = -Infinity;
      for (const edge of elements.edges) {
        const ts = parseTimestamp(edge.data.timestamp);
        if (ts !== null) {
          if (ts < tsMin) tsMin = ts;
          if (ts > tsMax) tsMax = ts;
        }
      }
      const tsRange = tsMax - tsMin || 1;
      for (const edge of elements.edges) {
        const ts = parseTimestamp(edge.data.timestamp);
        edge.data.normalizedTime = ts !== null ? (ts - tsMin) / tsRange : 0;
      }

      // ── Total counts ───────────────────────────────────────────────
      const countResult = await session.run(
        `MATCH (w:Wallet) WITH count(w) AS wc
         MATCH ()-[t:TRANSFER]->() RETURN wc, count(t) AS tc`
      );

      const totalWallets = countResult.records[0]?.get('wc');
      const totalTransfers = countResult.records[0]?.get('tc');

      return {
        elements,
        nodeCount: elements.nodes.length,
        edgeCount: elements.edges.length,
        totalWallets: toNum(totalWallets),
        totalTransfers: toNum(totalTransfers),
        clusterCount: clusterSizes.size,
        truncated: elements.edges.length >= limit,
        filters: { limit, coinType, address },
      };
    } finally {
      await session.close();
    }
  });
}

/** Convert timestamp string to epoch ms. Returns null on failure. */
function parseTimestamp(ts) {
  if (ts == null) return null;
  const s = String(ts).trim();
  // Pure numeric → epoch seconds or ms
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n > 1e12 ? n : n * 1000; // ms vs s heuristic
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function toNum(val) {
  if (val == null) return 0;
  if (typeof val === 'object' && typeof val.toNumber === 'function') return val.toNumber();
  return Number(val) || 0;
}
