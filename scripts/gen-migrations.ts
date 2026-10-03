import { generate } from './migrations';

const files = generate('db/migrations-src', 'volcano/migrations');
console.log(`Wrote ${files.length} migration files to volcano/migrations`);
