<?php

namespace Tests\Feature\Teams;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class CreateTeamTest extends TestCase {

    use RefreshDatabase;

    public function test_user_can_create_team() {
        $response = $this->get('/');

        $response->assertStatus(200);
    }
}
