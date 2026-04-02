-- Add RAZORPAY to allowed payment methods
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_method_check
  CHECK (payment_method::text = ANY (ARRAY['CASH','BANK_TRANSFER','CHEQUE','UPI','CARD','RAZORPAY','OTHER']::text[]));
