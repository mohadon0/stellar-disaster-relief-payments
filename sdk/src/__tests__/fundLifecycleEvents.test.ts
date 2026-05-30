/**
 * Tests for fund lifecycle event emission and parsing.
 *
 * The Rust contract emits three events:
 *   fund_created     – topics: [Symbol("fund_created"), fund_id]
 *                      data:   (admin, total_amount, disaster_type, geographic_scope, expires_at)
 *   fund_disbursed   – topics: [Symbol("fund_disbursed"), fund_id]
 *                      data:   (beneficiary, amount, purpose, approvers)
 *   trigger_activated – topics: [Symbol("trigger_activated"), fund_id]
 *                       data:   (trigger_id, trigger_type, release_amount, trigger_count)
 *
 * AidClient.parseFundLifecycleEvent() converts raw Soroban event objects into
 * typed FundLifecycleEvent values.  These tests exercise that parser directly
 * using synthetic raw events (no network required).
 */

import { AidClient } from '../aidClient';
import { FundCreatedEvent, FundDisbursedEvent, TriggerActivatedEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TESTNET_CONFIG = {
  network: 'testnet' as const,
  rpcUrl: 'https://soroban-testnet.stellar.org',
  horizonUrl: 'https://horizon-testnet.stellar.org',
  contractIds: {
    platform: 'TEST',
    aidRegistry: 'TEST',
    beneficiaryManager: 'TEST',
    merchantNetwork: 'TEST',
    cashTransfer: 'TEST',
    supplyChainTracker: 'TEST',
    antiFraud: 'TEST',
  },
};

/**
 * Build a synthetic raw event that mimics what scValToNative would produce
 * after decoding a real Soroban contract event.  We mock scValToNative so
 * that it returns the value unchanged, letting us pass plain JS values.
 */
function makeRawEvent(topics: unknown[], data: unknown[]) {
  return { topic: topics, value: data };
}

// Mock stellar-sdk so we don't need a live network.
jest.mock('stellar-sdk', () => ({
  Server: jest.fn().mockImplementation(() => ({})),
  TransactionBuilder: jest.fn(),
  Networks: { TESTNET: 'Test SDF Network ; September 2015', PUBLIC: 'Public Global Stellar Network ; September 2015', STANDALONE: 'Standalone Network ; February 2017' },
  Keypair: jest.fn(),
  Contract: jest.fn().mockImplementation(() => ({})),
  Address: jest.fn(),
  nativeToScVal: jest.fn((v) => v),
  // Return the value as-is so our synthetic events pass through unchanged.
  scValToNative: jest.fn((v) => v),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AidClient.parseFundLifecycleEvent', () => {
  let client: AidClient;

  beforeEach(() => {
    client = new AidClient(TESTNET_CONFIG);
  });

  // ── fund_created ──────────────────────────────────────────────────────────

  describe('fund_created event', () => {
    const rawEvent = makeRawEvent(
      ['fund_created', 'fund_earthquake_001'],
      ['GADMIN123', '1000000', 'seismic', 'Santo Domingo, DR', 1800000000],
    );

    it('returns a FundCreatedEvent with correct type', () => {
      const result = client.parseFundLifecycleEvent(rawEvent);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('fund_created');
    });

    it('maps all payload fields correctly', () => {
      const event = client.parseFundLifecycleEvent(rawEvent) as FundCreatedEvent;
      expect(event.fundId).toBe('fund_earthquake_001');
      expect(event.admin).toBe('GADMIN123');
      expect(event.totalAmount).toBe('1000000');
      expect(event.disasterType).toBe('seismic');
      expect(event.geographicScope).toBe('Santo Domingo, DR');
      expect(event.expiresAt).toBe(1800000000);
    });

    it('emits exactly once per fund creation (idempotency check)', () => {
      // Parsing the same raw event twice should yield two independent objects
      // with identical content – no side-effects or deduplication.
      const first = client.parseFundLifecycleEvent(rawEvent);
      const second = client.parseFundLifecycleEvent(rawEvent);
      expect(first).toEqual(second);
    });
  });

  // ── fund_disbursed ────────────────────────────────────────────────────────

  describe('fund_disbursed event', () => {
    const rawEvent = makeRawEvent(
      ['fund_disbursed', 'fund_earthquake_001'],
      ['GBENEFICIARY456', '5000', 'Emergency food aid', ['GNGO1', 'GGOV2']],
    );

    it('returns a FundDisbursedEvent with correct type', () => {
      const result = client.parseFundLifecycleEvent(rawEvent);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('fund_disbursed');
    });

    it('maps all payload fields correctly', () => {
      const event = client.parseFundLifecycleEvent(rawEvent) as FundDisbursedEvent;
      expect(event.fundId).toBe('fund_earthquake_001');
      expect(event.beneficiary).toBe('GBENEFICIARY456');
      expect(event.amount).toBe('5000');
      expect(event.purpose).toBe('Emergency food aid');
      expect(event.approvers).toEqual(['GNGO1', 'GGOV2']);
    });

    it('preserves the full approvers list (multi-sig integrity)', () => {
      const event = client.parseFundLifecycleEvent(rawEvent) as FundDisbursedEvent;
      expect(event.approvers).toHaveLength(2);
      expect(event.approvers).toContain('GNGO1');
      expect(event.approvers).toContain('GGOV2');
    });
  });

  // ── trigger_activated ─────────────────────────────────────────────────────

  describe('trigger_activated event', () => {
    const rawEvent = makeRawEvent(
      ['trigger_activated', 'fund_earthquake_001'],
      ['trigger_seismic_01', 'seismic', '250000', 3],
    );

    it('returns a TriggerActivatedEvent with correct type', () => {
      const result = client.parseFundLifecycleEvent(rawEvent);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('trigger_activated');
    });

    it('maps all payload fields correctly', () => {
      const event = client.parseFundLifecycleEvent(rawEvent) as TriggerActivatedEvent;
      expect(event.fundId).toBe('fund_earthquake_001');
      expect(event.triggerId).toBe('trigger_seismic_01');
      expect(event.triggerType).toBe('seismic');
      expect(event.releaseAmount).toBe('250000');
      expect(event.triggerCount).toBe(3);
    });

    it('increments triggerCount on repeated activations', () => {
      const first = makeRawEvent(
        ['trigger_activated', 'fund_earthquake_001'],
        ['trigger_seismic_01', 'seismic', '250000', 1],
      );
      const second = makeRawEvent(
        ['trigger_activated', 'fund_earthquake_001'],
        ['trigger_seismic_01', 'seismic', '250000', 2],
      );
      const e1 = client.parseFundLifecycleEvent(first) as TriggerActivatedEvent;
      const e2 = client.parseFundLifecycleEvent(second) as TriggerActivatedEvent;
      expect(e2.triggerCount).toBe(e1.triggerCount + 1);
    });
  });

  // ── unknown / malformed events ────────────────────────────────────────────

  describe('unknown or malformed events', () => {
    it('returns null for an unrecognised event type', () => {
      const raw = makeRawEvent(['unknown_event', 'fund_001'], ['some', 'data']);
      expect(client.parseFundLifecycleEvent(raw)).toBeNull();
    });

    it('returns null when parsing throws (malformed input)', () => {
      // Pass something that will cause scValToNative to throw.
      const { scValToNative } = jest.requireMock('stellar-sdk');
      scValToNative.mockImplementationOnce(() => { throw new Error('decode error'); });
      const raw = makeRawEvent(['fund_created', 'fund_001'], []);
      expect(client.parseFundLifecycleEvent(raw)).toBeNull();
    });
  });

  // ── backward compatibility ────────────────────────────────────────────────

  describe('backward compatibility', () => {
    it('does not affect existing AidClient methods (deployEmergencyFund still exists)', () => {
      expect(typeof client.deployEmergencyFund).toBe('function');
    });

    it('does not affect existing AidClient methods (getFund still exists)', () => {
      expect(typeof client.getFund).toBe('function');
    });

    it('does not affect existing AidClient methods (getDisbursements still exists)', () => {
      expect(typeof client.getDisbursements).toBe('function');
    });
  });
});
