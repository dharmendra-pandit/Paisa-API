'use strict';

const { CATEGORIES } = require('./categories');

/**
 * Knowledge base for the rule-based categorisation engine.
 *
 * `merchants` are matched against the normalised text as whole words or
 * contiguous phrases and carry high confidence — a merchant name is an
 * almost-certain signal. `keywords` are weaker, descriptive hints.
 *
 * Ordering does not matter: the engine scores every rule and picks the winner,
 * which keeps this table declarative and cheap to extend.
 */
const CATEGORY_RULES = Object.freeze([
  {
    category: CATEGORIES.FOOD,
    merchants: [
      'swiggy', 'zomato', 'ubereats', 'uber eats', 'dominos', 'pizza hut', 'mcdonalds', 'kfc', 'burger king',
      'subway', 'starbucks', 'cafe coffee day', 'chaayos', 'chai point', 'barbeque nation', 'haldiram',
      'bikanervala', 'faasos', 'behrouz', 'ovenstory', 'eatfit', 'freshmenu', 'box8', 'third wave coffee',
      'blue tokai', 'wow momo', 'theobroma', 'biryani blues',
    ],
    keywords: [
      'restaurant', 'cafe', 'coffee', 'diner', 'dining', 'food', 'lunch', 'dinner', 'breakfast', 'brunch', 'snack',
      'pizza', 'burger', 'biryani', 'dosa', 'thali', 'canteen', 'bakery', 'sweets', 'ice cream', 'juice', 'tea',
      'eatery', 'dhaba', 'takeaway', 'pub', 'brewery', 'sushi',
    ],
  },
  {
    category: CATEGORIES.GROCERIES,
    merchants: [
      'bigbasket', 'big basket', 'blinkit', 'grofers', 'zepto', 'dmart', 'd mart', 'reliance fresh', 'jiomart',
      'jio mart', 'natures basket', 'spencers', 'star bazaar', 'licious', 'freshtohome', 'fresh to home',
      'country delight', 'milkbasket', 'amazon fresh', 'instamart', 'otipy',
    ],
    keywords: [
      'grocery', 'groceries', 'supermarket', 'kirana', 'vegetables', 'veggies', 'fruits', 'milk', 'dairy', 'atta',
      'provision', 'ration', 'sabzi', 'butcher', 'eggs',
    ],
  },
  {
    category: CATEGORIES.TRANSPORT,
    merchants: [
      'uber', 'ola', 'ola cabs', 'rapido', 'meru', 'blusmart', 'blu smart', 'namma yatri', 'irctc', 'redbus',
      'abhibus', 'dmrc', 'delhi metro', 'bmtc', 'bmrcl', 'chalo', 'yulu', 'bounce', 'zoomcar', 'revv', 'quick ride',
    ],
    keywords: [
      'cab', 'taxi', 'auto rickshaw', 'rickshaw', 'metro', 'bus fare', 'train', 'railway', 'toll', 'fastag',
      'parking', 'commute', 'ride', 'transport', 'local travel',
    ],
  },
  {
    category: CATEGORIES.FUEL,
    merchants: [
      'indian oil', 'indianoil', 'iocl', 'bharat petroleum', 'bpcl', 'hp petrol', 'hpcl', 'hindustan petroleum',
      'shell', 'reliance petrol', 'nayara', 'jio bp',
    ],
    keywords: ['petrol', 'diesel', 'fuel', 'petrol pump', 'gas station', 'cng', 'filling station', 'charging station'],
  },
  {
    category: CATEGORIES.SHOPPING,
    merchants: [
      'amazon', 'flipkart', 'myntra', 'ajio', 'meesho', 'nykaa', 'tata cliq', 'tatacliq', 'snapdeal', 'shopsy',
      'decathlon', 'ikea', 'croma', 'reliance digital', 'vijay sales', 'lifestyle', 'shoppers stop', 'pantaloons',
      'westside', 'max fashion', 'zara', 'uniqlo', 'nike', 'adidas', 'puma', 'lenskart', 'titan', 'tanishq',
      'firstcry', 'urban ladder', 'pepperfry',
    ],
    keywords: [
      'shopping', 'clothes', 'clothing', 'apparel', 'footwear', 'shoes', 'electronics', 'gadget', 'mobile phone',
      'laptop', 'furniture', 'cosmetics', 'accessories', 'gift', 'purchase', 'watch', 'jewellery',
    ],
  },
  {
    category: CATEGORIES.ENTERTAINMENT,
    merchants: [
      'bookmyshow', 'book my show', 'pvr', 'inox', 'cinepolis', 'paytm insider', 'ticketnew', 'steam games',
      'playstation', 'xbox', 'nintendo', 'epic games',
    ],
    keywords: [
      'movie', 'cinema', 'theatre', 'concert', 'event ticket', 'amusement', 'bowling', 'arcade', 'gaming', 'game',
      'entertainment', 'stand up', 'comedy show',
    ],
  },
  {
    category: CATEGORIES.SUBSCRIPTIONS,
    merchants: [
      'netflix', 'amazon prime', 'prime video', 'hotstar', 'disney plus hotstar', 'jiohotstar', 'sonyliv',
      'sony liv', 'zee5', 'voot', 'jiocinema', 'spotify', 'gaana', 'wynk', 'youtube premium', 'youtube music',
      'apple music', 'apple icloud', 'icloud', 'google one', 'google workspace', 'microsoft 365', 'office 365',
      'adobe', 'canva', 'notion', 'figma', 'github', 'chatgpt', 'openai', 'claude', 'anthropic', 'linkedin premium',
      'audible', 'kindle unlimited', 'coursera plus', 'cult pass', 'dropbox', 'zoom', 'atlassian',
    ],
    keywords: [
      'subscription', 'membership', 'renewal', 'auto renew', 'autorenew', 'recurring payment', 'plan renewal',
      'monthly plan',
    ],
  },
  {
    category: CATEGORIES.BILLS_UTILITIES,
    merchants: [
      'airtel', 'jio', 'vodafone', 'bsnl', 'act fibernet', 'act broadband', 'hathway', 'excitel', 'tata play',
      'dish tv', 'adani electricity', 'tata power', 'bses', 'mseb', 'torrent power', 'indane', 'hp gas',
      'bharat gas', 'mahanagar gas', 'indraprastha gas',
    ],
    keywords: [
      'electricity', 'electric bill', 'water bill', 'gas bill', 'broadband', 'wifi', 'internet bill',
      'mobile recharge', 'recharge', 'postpaid', 'prepaid', 'dth', 'landline', 'utility', 'bill payment',
      'maintenance charges', 'society maintenance',
    ],
  },
  {
    category: CATEGORIES.RENT,
    merchants: ['nobroker', 'no broker', 'nestaway', 'stanza living', 'colive', 'zolo'],
    keywords: ['rent', 'house rent', 'flat rent', 'landlord', 'lease', 'pg rent', 'hostel fee', 'brokerage'],
  },
  {
    category: CATEGORIES.HEALTH,
    merchants: [
      'apollo pharmacy', 'pharmeasy', 'netmeds', 'tata 1mg', '1mg', 'medplus', 'wellness forever', 'practo',
      'cult fit', 'cultfit', 'curefit', 'healthifyme', 'dr lal pathlabs', 'metropolis', 'thyrocare',
      'max healthcare', 'fortis', 'manipal hospital',
    ],
    keywords: [
      'pharmacy', 'medicine', 'medical', 'doctor', 'clinic', 'hospital', 'lab test', 'diagnostic', 'dental',
      'dentist', 'gym', 'fitness', 'yoga', 'physiotherapy', 'health checkup', 'consultation', 'therapy',
    ],
  },
  {
    category: CATEGORIES.EDUCATION,
    merchants: [
      'byjus', 'unacademy', 'vedantu', 'coursera', 'udemy', 'upgrad', 'great learning', 'scaler', 'newton school',
      'physics wallah', 'khan academy', 'simplilearn',
    ],
    keywords: [
      'tuition', 'course fee', 'school fee', 'college fee', 'exam fee', 'books', 'stationery', 'coaching',
      'workshop fee', 'certification',
    ],
  },
  {
    category: CATEGORIES.TRAVEL,
    merchants: [
      'makemytrip', 'make my trip', 'goibibo', 'yatra', 'cleartrip', 'ixigo', 'easemytrip', 'airbnb', 'oyo',
      'oyo rooms', 'booking com', 'agoda', 'indigo', 'air india', 'vistara', 'spicejet', 'akasa air', 'taj hotels',
      'marriott', 'treebo', 'fabhotels',
    ],
    keywords: [
      'flight', 'airline', 'hotel', 'resort', 'holiday', 'vacation', 'trip', 'tour package', 'visa fee',
      'homestay', 'boarding', 'baggage',
    ],
  },
  {
    category: CATEGORIES.INVESTMENTS,
    merchants: [
      'zerodha', 'groww', 'upstox', 'angel one', 'angelone', 'kuvera', 'icici direct', 'hdfc securities',
      'kotak securities', 'paytm money', 'indmoney', 'smallcase', 'cams', 'kfintech',
    ],
    keywords: [
      'sip', 'mutual fund', 'investment', 'stocks', 'equity', 'demat', 'fixed deposit', 'recurring deposit',
      'gold bond', 'insurance premium', 'lic premium', 'elss', 'nps contribution', 'ppf',
    ],
  },
  {
    category: CATEGORIES.FEES_CHARGES,
    merchants: [],
    keywords: [
      'bank charge', 'service charge', 'convenience fee', 'processing fee', 'late fee', 'penalty', 'atm charge',
      'annual fee', 'overdraft', 'interest charged', 'surcharge', 'amc charges', 'gst on',
    ],
  },
  {
    category: CATEGORIES.TRANSFER,
    merchants: [],
    keywords: [
      'transfer to', 'sent to', 'imps', 'neft', 'rtgs', 'upi transfer', 'self transfer', 'fund transfer',
      'split payment', 'settle up', 'loan repayment', 'credit card payment', 'card bill payment',
    ],
  },
  {
    category: CATEGORIES.INCOME,
    merchants: [],
    keywords: [
      'salary', 'payroll', 'stipend', 'refund', 'cashback', 'reimbursement', 'interest credited', 'dividend',
      'bonus', 'freelance payment',
    ],
  },
]);

/** Merchant tokens that reveal a subscription regardless of the winning category. */
const SUBSCRIPTION_MERCHANT_HINTS = Object.freeze(
  CATEGORY_RULES.find((rule) => rule.category === CATEGORIES.SUBSCRIPTIONS).merchants.slice()
);

/**
 * Amount-based fallbacks, evaluated only when text scoring is inconclusive.
 * Deliberately conservative — a confident wrong guess is worse than OTHER.
 */
const AMOUNT_HEURISTICS = Object.freeze([
  { category: CATEGORIES.RENT, min: 5000, max: Infinity, requireAny: ['rent', 'landlord', 'lease', 'flat'] },
  { category: CATEGORIES.FEES_CHARGES, min: 0, max: 50, requireAny: ['charge', 'fee', 'gst'] },
]);

module.exports = { CATEGORY_RULES, SUBSCRIPTION_MERCHANT_HINTS, AMOUNT_HEURISTICS };
