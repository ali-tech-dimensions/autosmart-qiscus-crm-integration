'use strict';

// Phone normalisation for AutoSmart's three markets.
// The rules are deliberately small and readable. A production build would use
// libphonenumber, but for three countries a short table is easier to review.

const COUNTRIES = {
  MY: {
    code: '60',
    name: 'Malaysia',
    // Mobiles: 1x followed by 7 or 8 digits (01x numbers lose the leading 0).
    // Landlines: 3 to 9 followed by 7 or 8 digits.
    isValidNational: (nsn) => /^1\d{8,9}$/.test(nsn) || /^[3-9]\d{7,8}$/.test(nsn),
  },
  SG: {
    code: '65',
    name: 'Singapore',
    // Eight digits, starting with 3, 6, 8 or 9.
    isValidNational: (nsn) => /^[3689]\d{7}$/.test(nsn),
  },
  ID: {
    code: '62',
    name: 'Indonesia',
    // Mobiles start with 8 and run 9 to 12 digits; landlines start with 2 to 7.
    isValidNational: (nsn) => /^8\d{8,11}$/.test(nsn) || /^[2-7]\d{7,10}$/.test(nsn),
  },
};

function countryOrder(defaultCountry) {
  const keys = Object.keys(COUNTRIES);
  return [defaultCountry, ...keys.filter((k) => k !== defaultCountry)].filter((k) => COUNTRIES[k]);
}

function matchInternational(digits, defaultCountry) {
  for (const key of countryOrder(defaultCountry)) {
    const c = COUNTRIES[key];
    if (digits.startsWith(c.code)) {
      const nsn = digits.slice(c.code.length);
      if (c.isValidNational(nsn)) return { country: key, e164: `+${c.code}${nsn}` };
    }
  }
  return null;
}

/**
 * Normalise a raw phone value to E.164.
 * Returns { ok: true, e164, country } or { ok: false, reason, input, hint? }.
 * Reasons: missing, not_a_phone, ambiguous, invalid.
 */
function normalizePhone(raw, defaultCountry = 'MY') {
  const input = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!input) return { ok: false, reason: 'missing', input };

  // Facebook and Instagram give platform IDs or emails here, never phone numbers.
  if (/[a-z@]/i.test(input)) return { ok: false, reason: 'not_a_phone', input };

  let digits = input.replace(/\D/g, '');
  let international = input.startsWith('+');
  if (!international && digits.startsWith('00')) {
    digits = digits.slice(2);
    international = true;
  }
  if (!digits) return { ok: false, reason: 'invalid', input };

  if (international) {
    const hit = matchInternational(digits, defaultCountry);
    if (hit) return { ok: true, ...hit };
    // A plus sign means the customer gave a country code we do not serve.
    // E.164 allows up to 15 digits; we pass it on but mark the country as other.
    if (/^[1-9]\d{7,14}$/.test(digits)) return { ok: true, e164: `+${digits}`, country: 'other' };
    return { ok: false, reason: 'invalid', input };
  }

  if (digits.startsWith('0')) {
    // Local format: belongs to the default country, or it is not usable.
    const nsn = digits.slice(1);
    const home = COUNTRIES[defaultCountry];
    if (home && home.isValidNational(nsn)) {
      return { ok: true, e164: `+${home.code}${nsn}`, country: defaultCountry };
    }
    // Looks like a local number from another market (for example 0812... in Indonesia).
    // We do not guess. A person should confirm it with the customer.
    const elsewhere = countryOrder(defaultCountry)
      .filter((k) => k !== defaultCountry && COUNTRIES[k].isValidNational(nsn))
      .map((k) => `+${COUNTRIES[k].code}${nsn} (${COUNTRIES[k].name})`);
    if (elsewhere.length) return { ok: false, reason: 'ambiguous', input, hint: elsewhere.join(' or ') };
    return { ok: false, reason: 'invalid', input };
  }

  // No plus and no leading 0: usually a WhatsApp number with the country code.
  const hit = matchInternational(digits, defaultCountry);
  if (hit) return { ok: true, ...hit };

  // Last try: a national number typed without the leading 0.
  const home = COUNTRIES[defaultCountry];
  if (home && home.isValidNational(digits)) {
    return { ok: true, e164: `+${home.code}${digits}`, country: defaultCountry };
  }
  return { ok: false, reason: 'invalid', input };
}

module.exports = { normalizePhone, COUNTRIES };
