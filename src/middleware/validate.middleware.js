function validatePaymentInput(req, res, next) {
  let { name, email, phone, plan } = req.body;

  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
    return res.status(400).json({ error: 'Invalid name. Must be 2-100 characters.' });
  }
  if (typeof email !== 'string' || email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  if (typeof phone !== 'string' || phone.trim().length < 8 || phone.trim().length > 20) {
    return res.status(400).json({ error: 'Invalid phone number.' });
  }
  const validPlans = ['weekly', 'monthly', '3-months', '6-months', 'yearly'];
  if (!validPlans.includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan. Must be "weekly", "monthly", "3-months", "6-months", or "yearly".' });
  }

  req.body.name = name.trim();
  req.body.email = email.toLowerCase().trim();

  // Normalize phone: auto-add +20 for Egyptian numbers without prefix
  let normalizedPhone = phone.trim();
  if (!normalizedPhone.startsWith('+')) {
    normalizedPhone = '+20' + normalizedPhone.replace(/^0+/, '');
  }
  req.body.phone = normalizedPhone;

  next();
}

module.exports = { validatePaymentInput };
