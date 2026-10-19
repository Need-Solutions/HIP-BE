import { AdminSeeder } from "./admin.seeder";

export const RunSeeders = async () => {
  await AdminSeeder();
};
