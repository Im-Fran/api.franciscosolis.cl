<?php

namespace Database\Seeders;

use App\Helpers\Helper;
use App\Models\User;
use Illuminate\Database\Seeder;

class UserSeeder extends Seeder
{
    public function run(): void
    {
        User::factory()
            ->count(500)
            ->create();

        /*
         * Create users that are assigned to 1 to 3 teams.
         * See: https://laravel.com/docs/10.x/eloquent-factories#has-many-relationships
         */
        Helper::repeat(10, fn() => User::factory()
            ->hasTeams(rand(1, 3))
            ->create()
        );
    }
}
