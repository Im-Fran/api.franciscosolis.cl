<?php

namespace Tests\Feature\Teams;

use App\Models\Teams\Team;
use App\Models\User;
use Database\Seeders\UserSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * @small
 */
class SearchTeamsTest extends TestCase {
    use RefreshDatabase;

    public function test_public_team_view_will_not_show_private_data() {
        $this->seed([
            UserSeeder::class, // No need for team seeder because user creates teams.
        ]);

        $response = $this->get(route('teams.index'));

        $response->assertStatus(200);
        $response->assertJsonCount(10, 'data');

        // Emails shouldn't be visible
        $response->assertJsonMissingPath('data.*.email');
    }

    public function test_show_team() {
        $team = Team::factory()
            ->for(User::factory()->create())
            ->create();

        $response = $this->get(route('teams.show', [
            'team' => $team->id,
            'include' => 'members',
        ]));

        $response->assertStatus(200);
        $response->assertJsonCount($team->members()->count(), 'data.members');
    }
}
