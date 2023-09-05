<?php

namespace Tests\Feature;

// use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * @small
 */
class StatusTest extends TestCase {
    /**
     * A basic test example.
     */
    public function test_the_status_of_app_is_ok(): void {
        $response = $this->get('/');

        $response->assertStatus(200);
        $response->assertJson(['status' => 'ok']);
    }
}
