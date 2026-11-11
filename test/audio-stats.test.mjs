import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAudioStats } from '../public/audio-stats.js';
const report = entries => new Map(entries.map(e => [e.id, e]));
const initial = { id: 'rx', type: 'inbound-rtp', kind: 'audio', timestamp: 1000, packetsReceived: 100, packetsLost: 10, concealedSamples: 1000, totalSamplesReceived: 48000, jitterBufferDelay: 100, jitterBufferEmittedCount: 1000, bytesReceived: 1000, jitter: .01 };
test('audio statistics use interval deltas and seconds-to-ms conversion', () => {
  const previous = summarizeAudioStats(report([initial])).baseline;
  const { metrics } = summarizeAudioStats(report([{ ...initial, timestamp: 3000, packetsReceived: 190, packetsLost: 20, concealedSamples: 5800, totalSamplesReceived: 144000, jitterBufferDelay: 196, jitterBufferEmittedCount: 1960, bytesReceived: 9000, jitter: .025 }]), previous);
  assert.equal(metrics.lossPct, 10); assert.equal(metrics.concealPct, 5);
  assert.equal(metrics.jitterMs, 25); assert.equal(metrics.bufferMs, 100); assert.equal(metrics.rxKbps, 32);
});
test('missing fields and the first sample remain unknown rather than zero', () => {
  const { metrics } = summarizeAudioStats(report([initial]));
  assert.equal(metrics.lossPct, null); assert.equal(metrics.bufferMs, null);
  assert.equal(metrics.rxLevel, null); assert.equal(metrics.rxKbps, null);
});
test('counter resets do not produce negative rates; late packets do not mean negative loss', () => {
  const previous = summarizeAudioStats(report([initial])).baseline;
  const { metrics } = summarizeAudioStats(report([{ ...initial, timestamp: 3000, packetsReceived: 200, packetsLost: 8, bytesReceived: 10, totalSamplesReceived: 10 }]), previous);
  assert.equal(metrics.lossPct, 0); assert.equal(metrics.rxKbps, null); assert.equal(metrics.concealPct, null);
});
test('transmit rates and selected transport RTT are independent of video or unselected paths', () => {
  const tx = { id: 'tx', type: 'outbound-rtp', kind: 'audio', timestamp: 1000, bytesSent: 1000 };
  const baseline = summarizeAudioStats(report([tx])).baseline;
  const { metrics } = summarizeAudioStats(report([
    { ...tx, timestamp: 3000, bytesSent: 9000 },
    { id: 'video', type: 'inbound-rtp', kind: 'video', jitter: 99 },
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
    { id: 'pair', type: 'candidate-pair', currentRoundTripTime: .03 },
    { id: 'other', type: 'candidate-pair', currentRoundTripTime: 99 },
    { id: 'mic', type: 'media-source', kind: 'audio', audioLevel: .123 }
  ]), baseline);
  assert.equal(metrics.txKbps, 32); assert.equal(metrics.rttMs, 30); assert.equal(metrics.micLevel, .12);
  assert.equal(metrics.jitterMs, undefined);
});

test('video upload is measured separately from audio when comparing a paused video sender', () => {
  const video = { id: 'videoTx', type: 'outbound-rtp', kind: 'video', timestamp: 1000, bytesSent: 10000 };
  const first = summarizeAudioStats(report([video])).baseline;
  const active = summarizeAudioStats(report([{ ...video, timestamp: 3000, bytesSent: 260000 }]), first);
  assert.equal(active.metrics.videoTxKbps, 1000);
  const paused = summarizeAudioStats(report([{ ...video, timestamp: 5000, bytesSent: 260000 }]), active.baseline);
  assert.equal(paused.metrics.videoTxKbps, 0); assert.equal(paused.metrics.txKbps, undefined);
});
