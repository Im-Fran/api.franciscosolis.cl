<?php

namespace Tests\Feature\Teams;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * @small
 */
class CreateTeamTest extends TestCase {
    use RefreshDatabase;

    public function test_user_can_create_team() {
        // First, we authenticate a user and then we can create the team
        $user = User::factory()->create();

        $response = $this->actingAs($user)->post(route('teams.store'), [
            'name' => 'FranciscoSolis',
            'bio' => 'We create free software for the world.',
            'website' => 'https://franciscosolis.cl',
            'emails' => [
                ['label' => 'Lead Developer', 'value' => 'fran@franciscosolis.cl'],
                ['label' => 'Support', 'value' => 'fran@franciscosolis.cl'],
            ],
            'links' => [
                ['icon' => 'fab fa-github', 'label' => 'GitHub', 'value' => 'https://github.com/Im-Fran'],
                ['icon' => 'fab fa-twitter', 'label' => 'Twitter', 'value' => 'https://twitter.com/Im_Fran_'],
            ],
        ]);

        $response->assertStatus(201);
        $response->assertJsonStructure([
            'data' => [
                'id',
                'user_id',
                'name',
                'slug',
                'bio',
                'website',
                'links',
                'emails',
                'created_at',
                'updated_at',
            ],
        ]);
    }
}
