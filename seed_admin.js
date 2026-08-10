import dotenv from 'dotenv';
dotenv.config();

const runSeeder = async () => {
    const { default: pool } = await import('./src/config/db.js');
    const { hashPassword } = await import('./src/config/jwt.js');
    const userModel = (await import('./src/models/User.model.js')).default;

    console.log("Seeding an OWNER account...");
    // Usage: node seed_admin.js [email] [password]
    const email = process.argv[2] || 'admin@example.com';
    const password = process.argv[3] || 'password123';

    // Check if exists
    const existing = await userModel.findByEmail(email, pool);
    if (existing) {
        console.log(`User ${email} already exists!`);
    } else {
        const hashedPassword = await hashPassword(password);
        const sponsorCode = await userModel.getUniqueSponsorCode(pool);

        const userData = {
            name: 'System Admin',
            email: email,
            password: hashedPassword,
            role: 'OWNER',
            sponsor_code: sponsorCode,
            token_version: 1,
            is_active: true
        };

        await userModel.create(userData, pool);
        console.log(`Created new owner account!`);
        console.log(`Email: ${email}`);
        console.log(`Password: ${password}`);
    }
    process.exit(0);
};

runSeeder().catch(err => {
    console.error("Error seeding admin:", err);
    process.exit(1);
});
