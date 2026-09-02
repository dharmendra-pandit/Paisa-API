'use strict';

const {
  categorizeByRules,
  buildMerchantKey,
  looksLikeSubscription,
} = require('../src/services/categorization.service');
const { CATEGORIES } = require('../src/constants/categories');

/** Pure unit tests — no database, no HTTP. */
describe('Categorisation rule engine', () => {
  describe('merchant and keyword matching', () => {
    const cases = [
      [{ merchant: 'Swiggy', note: 'Dinner' }, CATEGORIES.FOOD],
      [{ merchant: 'BigBasket' }, CATEGORIES.GROCERIES],
      [{ merchant: 'Uber', note: 'Ride to office' }, CATEGORIES.TRANSPORT],
      [{ merchant: 'Indian Oil', note: 'Petrol' }, CATEGORIES.FUEL],
      [{ merchant: 'Myntra', note: 'Shirt' }, CATEGORIES.SHOPPING],
      [{ merchant: 'BookMyShow', note: 'Movie tickets' }, CATEGORIES.ENTERTAINMENT],
      [{ merchant: 'Netflix' }, CATEGORIES.SUBSCRIPTIONS],
      [{ merchant: 'Tata Power', note: 'Electricity bill' }, CATEGORIES.BILLS_UTILITIES],
      [{ note: 'House rent for August', merchant: 'Landlord' }, CATEGORIES.RENT],
      [{ merchant: 'Apollo Pharmacy', note: 'Medicines' }, CATEGORIES.HEALTH],
      [{ merchant: 'Coursera', note: 'Course fee' }, CATEGORIES.EDUCATION],
      [{ merchant: 'MakeMyTrip', note: 'Flight booking' }, CATEGORIES.TRAVEL],
      [{ merchant: 'Groww', note: 'Monthly SIP' }, CATEGORIES.INVESTMENTS],
    ];

    it.each(cases)('classifies %o as %s', (input, expected) => {
      expect(categorizeByRules(input).category).toBe(expected);
    });

    it('prefers the longer, more specific merchant phrase', () => {
      // "amazon" alone is Shopping; "amazon prime" is a subscription.
      expect(categorizeByRules({ merchant: 'Amazon' }).category).toBe(CATEGORIES.SHOPPING);
      expect(categorizeByRules({ merchant: 'Amazon Prime' }).category).toBe(CATEGORIES.SUBSCRIPTIONS);
    });

    it('matches whole words only', () => {
      // "ola" must not match inside "chocolate".
      const result = categorizeByRules({ merchant: 'Chocolate Room', note: 'dessert' });
      expect(result.category).not.toBe(CATEGORIES.TRANSPORT);
    });

    it('falls back to OTHER with low confidence when nothing matches', () => {
      const result = categorizeByRules({ merchant: 'Zzyzx Trading', note: 'misc' });
      expect(result.category).toBe(CATEGORIES.OTHER);
      expect(result.method).toBe('fallback');
      expect(result.confidence).toBeLessThan(0.3);
    });

    it('reports the token it matched on', () => {
      expect(categorizeByRules({ merchant: 'Swiggy' }).matchedOn).toBe('swiggy');
    });
  });

  describe('transaction direction', () => {
    it('classifies a credit as income', () => {
      const result = categorizeByRules({ merchant: 'Acme Payroll', note: 'Salary', type: 'credit' });
      expect(result.category).toBe(CATEGORIES.INCOME);
      expect(result.confidence).toBeGreaterThan(0.9);
    });

    it('classifies an unlabelled credit as income with lower confidence', () => {
      const result = categorizeByRules({ merchant: 'Unknown', type: 'credit' });
      expect(result.category).toBe(CATEGORIES.INCOME);
      expect(result.confidence).toBeLessThan(0.9);
    });

    it('keeps an incoming self-transfer out of income', () => {
      const result = categorizeByRules({ note: 'IMPS self transfer from savings', type: 'credit' });
      expect(result.category).toBe(CATEGORIES.TRANSFER);
    });
  });

  describe('buildMerchantKey', () => {
    it('collapses variants of the same merchant onto one key', () => {
      const keys = [
        buildMerchantKey('SWIGGY'),
        buildMerchantKey('Swiggy India Pvt Ltd'),
        buildMerchantKey('swiggy*order 8837'),
        buildMerchantKey('  Swiggy  '),
      ];
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toBe('swiggy');
    });

    it('keeps a short numeric token that is part of the name', () => {
      expect(buildMerchantKey('Tata 1mg')).toContain('1mg');
    });

    it('does not reduce a name to nothing', () => {
      expect(buildMerchantKey('Pvt Ltd')).not.toBe('');
    });
  });

  describe('looksLikeSubscription', () => {
    it('recognises a known subscription merchant', () => {
      expect(looksLikeSubscription({ merchant: 'Spotify' })).toBe(true);
    });

    it('recognises renewal wording', () => {
      expect(looksLikeSubscription({ note: 'Annual membership renewal' })).toBe(true);
    });

    it('treats auto-debit as a subscription signal', () => {
      expect(looksLikeSubscription({ merchant: 'Some Gym', paymentMethod: 'auto_debit' })).toBe(true);
    });

    it('does not flag an ordinary purchase', () => {
      expect(looksLikeSubscription({ merchant: 'Swiggy', note: 'Dinner' })).toBe(false);
    });
  });
});
