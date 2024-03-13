<?php

namespace Database\Factories\Projects;

use App\Models\Projects\Project;
use Illuminate\Database\Eloquent\Factories\Factory;

class ProjectFactory extends Factory {
    protected $model = Project::class;

    public function definition(): array {
        return [
            'created_at' => now(),
            'updated_at' => now(),
            'name' => $this->faker->name,
            'tagline' => $this->faker->sentence,
            'description' => $this->faker->sentences(asText: true),
            'display_image' => $this->faker->imageUrl,
            'body' => $this->faker->text,
        ];
    }
}
