import fs from 'fs/promises';
import path from 'path';
import pool from '../src/config/db.js';

const paymentsCols = [
  'bank_name','branch_name','account_number','ifsc_code','upi_id','cheque_number','cheque_date','card_last4','card_network','payment_time','payment_reference','collected_by_name','verified_by','verification_date','remarks'
];

const bookingCols = [
  'client_aadhar','client_pan','client_dob','client_occupation','client_company','nominee_name','nominee_phone','nominee_relation','registration_number','registration_date','possession_date'
];

async function verifyColumns(client, table, cols) {
  const q = `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = ANY($2)`;
  const res = await client.query(q, [table, cols]);
  const found = res.rows.map(r => r.column_name);
  const missing = cols.filter(c => !found.includes(c));
  return { found, missing };
}

(async () => {
  try {
    const sqlFile = path.join(process.cwd(), 'src', 'migrations', 'enhanced_payments_clients.sql');
    const sql = await fs.readFile(sqlFile, 'utf8');
    console.log('Running migration file:', sqlFile);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log('Migration applied successfully.');

      // verification
      const paymentsCheck = await verifyColumns(client, 'payments', paymentsCols);
      const bookingsCheck = await verifyColumns(client, 'plot_bookings', bookingCols);

      console.log('\nPayments table - found columns:', paymentsCheck.found.length, '/', paymentsCols.length);
      if (paymentsCheck.missing.length) console.log('Missing in payments:', paymentsCheck.missing.join(', '));
      else console.log('All payments columns present.');

      console.log('\nplot_bookings table - found columns:', bookingsCheck.found.length, '/', bookingCols.length);
      if (bookingsCheck.missing.length) console.log('Missing in plot_bookings:', bookingsCheck.missing.join(', '));
      else console.log('All plot_bookings columns present.');

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Migration failed (rolled back):', err.message || err);
      process.exitCode = 2;
    } finally {
      client.release();
      await pool.end();
    }
  } catch (err) {
    console.error('Error reading migration file or connecting to DB:', err.message || err);
    process.exitCode = 1;
  }
})();
