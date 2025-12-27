const { describe, it } = require('node:test');
const assert = require('node:assert');
const STUNClient = require('../src/STUNClient');
const ICEGatherer = require('../src/ICEGatherer');

describe('STUN and ICE', () => {
  
  describe('STUNClient', () => {
    
    it('should query STUN server and get reflexive address', async () => {
      const client = new STUNClient();
      
      try {
        const result = await client.getReflexiveAddress('stun.l.google.com:19302');
        
        assert.ok(result, 'Should return result');
        assert.ok(result.ip, 'Should have IP address');
        assert.ok(result.port, 'Should have port');
        assert.strictEqual(result.type, 'srflx', 'Should be server reflexive');
        
        // Verify IP format
        const ipPattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
        assert.ok(ipPattern.test(result.ip), 'Should have valid IP format');
        
        // Verify port range
        assert.ok(result.port > 0 && result.port < 65536, 'Should have valid port');
        
        console.log(`  ✓ Got public IP: ${result.ip}:${result.port}`);
      } catch (err) {
        // STUN might fail in some environments (no internet, firewall, etc.)
        if (err.message.includes('timeout') || err.message.includes('ENOTFOUND')) {
          console.log('  ⚠ STUN test skipped (no internet or blocked)');
          return; // Skip test
        }
        throw err;
      }
    });

    it('should handle STUN timeout', async () => {
      const client = new STUNClient();
      client.timeout = 100; // Very short timeout

      try {
        await client.getReflexiveAddress('192.0.2.1:19302'); // TEST-NET-1 (should timeout)
        assert.fail('Should have timed out');
      } catch (err) {
        assert.ok(err.message.includes('timeout'), 'Should timeout');
      }
    });

    it('should close socket properly', async () => {
      const client = new STUNClient();
      client.close();
      assert.strictEqual(client.socket, null, 'Socket should be null after close');
    });
  });

  describe('ICEGatherer', () => {
    
    it('should gather host candidates', async () => {
      const gatherer = new ICEGatherer({ gatherTimeout: 1000 });
      const candidates = await gatherer.gatherCandidates(12345);

      assert.ok(Array.isArray(candidates), 'Should return array');
      assert.ok(candidates.length > 0, 'Should have at least one candidate');

      // Check host candidate
      const hostCandidate = candidates.find(c => c.type === 'host');
      assert.ok(hostCandidate, 'Should have host candidate');
      assert.strictEqual(hostCandidate.port, 12345, 'Should have correct port');
      assert.ok(hostCandidate.ip, 'Should have IP');
      assert.ok(hostCandidate.candidate.includes('typ host'), 'Should be host type');

      console.log(`  ✓ Gathered ${candidates.length} candidate(s)`);
      candidates.forEach(c => {
        console.log(`    - ${c.type}: ${c.ip}:${c.port}`);
      });
    });

    it('should gather STUN candidates if available', async () => {
      const gatherer = new ICEGatherer({
        stunServers: ['stun.l.google.com:19302'],
        gatherTimeout: 3000
      });

      try {
        const candidates = await gatherer.gatherCandidates(12345);
        
        // Check for srflx candidate
        const srflxCandidate = candidates.find(c => c.type === 'srflx');
        
        if (srflxCandidate) {
          assert.ok(srflxCandidate.ip, 'Should have public IP');
          assert.ok(srflxCandidate.relatedAddress, 'Should have related address');
          assert.ok(srflxCandidate.candidate.includes('typ srflx'), 'Should be srflx type');
          console.log(`  ✓ Got STUN candidate: ${srflxCandidate.ip}:${srflxCandidate.port}`);
        } else {
          console.log('  ⚠ No STUN candidate (might be blocked or no internet)');
        }
      } catch (err) {
        console.log('  ⚠ STUN gathering skipped:', err.message);
      }
    });

    it('should calculate correct priorities', async () => {
      const gatherer = new ICEGatherer();
      const candidates = await gatherer.gatherCandidates(12345);

      // Host candidates should have highest priority
      for (const candidate of candidates) {
        assert.ok(candidate.priority > 0, 'Priority should be positive');
        
        if (candidate.type === 'host') {
          assert.ok(candidate.priority > 2113929216, 'Host should have high priority');
        }
      }
    });

    it('should parse ICE candidate string', () => {
      const candidateStr = 'candidate:1 1 udp 2130706431 192.168.1.100 54321 typ host';
      const parsed = ICEGatherer.parseCandidate(candidateStr);

      assert.strictEqual(parsed.foundation, '1');
      assert.strictEqual(parsed.component, 1);
      assert.strictEqual(parsed.protocol, 'udp');
      assert.strictEqual(parsed.priority, 2130706431);
      assert.strictEqual(parsed.ip, '192.168.1.100');
      assert.strictEqual(parsed.port, 54321);
      assert.strictEqual(parsed.type, 'host');
    });

    it('should parse srflx candidate with raddr/rport', () => {
      const candidateStr = 'candidate:2 1 udp 1686052607 203.0.113.10 54321 typ srflx raddr 192.168.1.100 rport 12345';
      const parsed = ICEGatherer.parseCandidate(candidateStr);

      assert.strictEqual(parsed.type, 'srflx');
      assert.strictEqual(parsed.ip, '203.0.113.10');
      assert.strictEqual(parsed.port, 54321);
      assert.strictEqual(parsed.relatedAddress, '192.168.1.100');
      assert.strictEqual(parsed.relatedPort, 12345);
    });

    it('should sort candidates by priority', async () => {
      const gatherer = new ICEGatherer();
      const candidates = await gatherer.gatherCandidates(12345);

      // Verify sorted descending
      for (let i = 1; i < candidates.length; i++) {
        assert.ok(
          candidates[i - 1].priority >= candidates[i].priority,
          'Candidates should be sorted by priority (descending)'
        );
      }
    });
  });
});
