<?php

namespace Tests\Feature\Account;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

/**
 * @small
 */
class UpdatePasswordTest extends TestCase {
    use RefreshDatabase;

    public function test_user_can_update_password() {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('account.password'), [
                'current_password' => 'password',
                'password' => 'new-password',
                'password_confirmation' => 'new-password',
            ])
            ->assertStatus(200)
            ->assertJson([
                'message' => 'Password updated successfully.',
            ]);

        $this->assertTrue(Hash::check('new-password', $user->fresh()->password));
    }

    public function test_user_cannot_update_password() {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('account.password'), [
                'current_password' => 'wrong-password',
                'password' => 'new-password',
                'password_confirmation' => 'new-password',
            ])
            ->assertStatus(401)
            ->assertJson([
                'message' => 'The provided password does not match your current password.',
            ]);

        $this->assertTrue(Hash::check('password', $user->fresh()->password));
    }
}
