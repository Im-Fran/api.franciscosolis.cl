<?php

namespace Tests\Feature\Teams;

use App\Models\Teams\Team;
use Database\Seeders\UserSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class SearchTeamsTest extends TestCase {
    use RefreshDatabase;

    public function test_public_team_will_not_leak_information() {
        $this->seed([
            UserSeeder::class, // No need for teams seeder because user creates teams.
        ]);

        $response = $this->get(route('teams.index'));

        $response->assertStatus(200);
        $response->assertJsonCount(10, 'data');

        // Emails shouldn't be visible
        $response->assertJsonMissingPath('data.*.email');
    }

    public function test_show_team() {
        $this->seed([
            UserSeeder::class, // No need for teams seeder because user creates teams.
        ]);

        $team = Team::inRandomOrder()
            ->withCount('members')
            ->first();

        $response = $this->get(route('teams.show', [
            'team' => $team->id,
            'include' => 'members',
        ]));

        $response->assertStatus(200);
        $response->assertJsonCount($team->members_count, 'data.members');
    }
}
