import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { Role, TableStatus } from './generated/prisma/enums';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL must be configured');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const catalogue = [
  { name: 'Appetizers', items: [
    ['Crispy Calamari', 'Lightly fried calamari served with lemon aioli.', 12.5], ['Edamame', 'Steamed young soybeans finished with sea salt.', 6.5], ['Chicken Satay', 'Grilled chicken skewers with peanut sauce.', 10], ['Shrimp Tempura', 'Golden shrimp tempura with a house dipping sauce.', 13.5],
  ] },
  { name: 'Mains', items: [
    ['Teriyaki Salmon', 'Grilled salmon glazed with teriyaki, served with rice.', 24], ['Pad Thai', 'Rice noodles, vegetables, egg, and tamarind sauce.', 18], ['Beef Bulgogi Bowl', 'Marinated grilled beef with rice and seasonal vegetables.', 21], ['Green Curry', 'Coconut green curry with vegetables and jasmine rice.', 19],
  ] },
  { name: 'Desserts', items: [
    ['Mango Sticky Rice', 'Sweet coconut sticky rice with ripe mango.', 9], ['Chocolate Lava Cake', 'Warm chocolate cake with a molten center.', 10], ['Matcha Cheesecake', 'Creamy cheesecake with Japanese matcha.', 9.5],
  ] },
  { name: 'Drinks', items: [
    ['Thai Iced Tea', 'Black tea with spices and sweetened milk.', 5.5], ['Fresh Lime Soda', 'Fresh lime juice topped with sparkling water.', 4.5], ['Ginger Lemonade', 'House lemonade with fresh ginger.', 5], ['Jasmine Green Tea', 'Fragrant jasmine green tea, served hot or iced.', 4],
  ] },
  { name: 'Specials', items: [
    ['Chef’s Sushi Platter', 'Chef-selected nigiri and seasonal sushi rolls.', 29], ['Coconut Prawn Curry', 'Tiger prawns in a rich coconut curry sauce.', 25], ['Wagyu Beef Tataki', 'Seared wagyu with ponzu and crispy garlic.', 27],
  ] },
];

async function seed(): Promise<void> {
  // Clear dependent records first so the seed can be rerun against an existing database.
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.menuItem.deleteMany();
  await prisma.category.deleteMany();
  await prisma.table.deleteMany();
  await prisma.user.deleteMany();

  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';
  const employeePassword = process.env.SEED_EMPLOYEE_PASSWORD ?? 'Employee123!';
  const [adminHash, employeeHash] = await Promise.all([
    bcrypt.hash(adminPassword, 12), bcrypt.hash(employeePassword, 12),
  ]);
  await prisma.user.create({ data: { name: 'Restaurant Admin', email: 'admin@restaurant.com', password: adminHash, role: Role.ADMIN } });
  await prisma.user.createMany({ data: [
    { name: 'Alex Morgan', email: 'waiter1@restaurant.com', password: employeeHash, role: Role.EMPLOYEE },
    { name: 'Jamie Chen', email: 'waiter2@restaurant.com', password: employeeHash, role: Role.EMPLOYEE },
  ] });

  for (const group of catalogue) {
    const category = await prisma.category.create({ data: { name: group.name } });
    await prisma.menuItem.createMany({ data: group.items.map(([name, description, price]) => ({
      name: name as string, description: description as string, price: price as number, categoryId: category.id,
    })) });
  }

  const section = await prisma.floorSection.upsert({ where: { position: 0 }, update: {}, create: { name: 'Main floor', position: 0 } });
  await prisma.table.createMany({ data: [2, 4, 2, 4, 4, 8, 2, 4, 8, 4].map((capacity, index) => ({
    tableNumber: String(index + 1), capacity, status: TableStatus.AVAILABLE, sectionId: section.id,
  })) });
  console.info('Seed complete. Admin: admin@restaurant.com; employees: waiter1@restaurant.com and waiter2@restaurant.com. Set SEED_ADMIN_PASSWORD and SEED_EMPLOYEE_PASSWORD to override development passwords.');
}

seed().catch((error: unknown) => {
  console.error('Database seed failed:', error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
