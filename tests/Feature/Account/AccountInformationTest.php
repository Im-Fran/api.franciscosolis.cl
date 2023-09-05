<?php

namespace Tests\Feature\Account;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * @small
 */
class AccountInformationTest extends TestCase {
    use RefreshDatabase;

    public function test_user_can_view_account_information() {
        $user = User::factory()->create();

        $response = $this->actingAs($user)->get('/account/information');
        $response->assertJson([
            'name' => $user->name,
            'email' => $user->email,
        ])->assertStatus(200);
    }

    public function test_user_can_update_account_information() {
        $user = User::factory()->create();

        $newData = [
            'name' => 'Francisco Solis',
            'email' => 'fran@franciscosolis.cl',
        ];
        $response = $this->actingAs($user)->post('/account/information', $newData);

        $this->assertAuthenticated();
        $response->assertJson([
            'message' => 'Account information updated successfully.',
        ])->assertStatus(200);

        $response = $this->actingAs($user)->get('/account/information');
        $response->assertJson($newData)
            ->assertStatus(200);
    }
}
