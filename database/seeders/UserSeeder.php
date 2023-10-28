<?php

namespace Database\Seeders;

use App\Helpers\Helper;
use App\Models\User;
use Illuminate\Database\Seeder;

class UserSeeder extends Seeder {

    public function run(): void {
        User::factory()
            ->count(rand(500, 3000))
            ->create();

        Helper::repeat(10, fn() => User::factory()
            ->hasTeams(rand(1, 3))
            ->create()
        );
    }
}
