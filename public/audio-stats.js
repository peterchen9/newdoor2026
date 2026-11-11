// Interval metrics, not lifetime averages. Missing browser fields remain null.
const finite = n => typeof n === 'number' && Number.isFinite(n);
const rounded = n => finite(n) ? Math.round(n * 100) / 100 : null;
function delta(now, before, key) {
  if (!before || !finite(now[key]) || !finite(before[key])) return null;
  const result = now[key] - before[key];
  return result >= 0 ? result : null;
}
const fraction = (a, b, factor = 1) => finite(a) && finite(b) && b > 0 ? rounded(a / b * factor) : null;
export function summarizeAudioStats(report, previous = new Map()) {
  const baseline = new Map(), metrics = {};
  for (const s of report.values()) {
    const isAudio = (s.kind || s.mediaType) === 'audio';
    if (s.type === 'outbound-rtp' && (s.kind || s.mediaType) === 'video' && !s.isRemote) {
      baseline.set(s.id, { ...s });
      metrics.videoTxKbps = fraction(delta(s, previous.get(s.id), 'bytesSent'), delta(s, previous.get(s.id), 'timestamp'), 8);
    }
    if (isAudio && ['inbound-rtp', 'outbound-rtp'].includes(s.type) && !s.isRemote) {
      baseline.set(s.id, { ...s });
      const before = previous.get(s.id), dt = delta(s, before, 'timestamp');
      if (s.type === 'inbound-rtp') {
        const received = delta(s, before, 'packetsReceived');
        // packetsLost is signed and may decrease when late packets arrive.
        const lost = before && finite(s.packetsLost) && finite(before.packetsLost) ? Math.max(0, s.packetsLost - before.packetsLost) : null;
        metrics.lossPct = fraction(lost, finite(received) && finite(lost) ? received + lost : null, 100);
        metrics.concealPct = fraction(delta(s, before, 'concealedSamples'), delta(s, before, 'totalSamplesReceived'), 100);
        metrics.jitterMs = rounded(finite(s.jitter) ? s.jitter * 1000 : null);
        metrics.bufferMs = fraction(delta(s, before, 'jitterBufferDelay'), delta(s, before, 'jitterBufferEmittedCount'), 1000);
        metrics.rxKbps = fraction(delta(s, before, 'bytesReceived'), dt, 8);
        metrics.rxLevel = rounded(s.audioLevel);
      } else metrics.txKbps = fraction(delta(s, before, 'bytesSent'), dt, 8);
    }
    if (s.type === 'media-source' && isAudio) metrics.micLevel = rounded(s.audioLevel);
    if (s.type === 'transport' && s.selectedCandidatePairId) {
      const pair = report.get(s.selectedCandidatePairId);
      metrics.rttMs = rounded(finite(pair?.currentRoundTripTime) ? pair.currentRoundTripTime * 1000 : null);
    }
  }
  return { metrics, baseline };
}
