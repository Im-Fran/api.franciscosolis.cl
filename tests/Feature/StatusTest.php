<?php

namespace Tests\Feature;

use Tests\TestCase;

/**
 * @small
 */
class StatusTest extends TestCase {
    public function test_status_is_ok(): void {
        $response = $this->get('/');

        $response->assertStatus(200);
        $response->assertJson(['status' => 'ok']);
    }
}
