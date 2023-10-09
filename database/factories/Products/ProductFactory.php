<?php

namespace Database\Factories\Products;

use App\Models\Products\Product;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Carbon;

class ProductFactory extends Factory
{
    protected $model = Product::class;

    public function definition(): array
    {
        return [
            'name' => $this->faker->name(),
            'slug' => $this->faker->slug(),
            'user_id' => $this->faker->randomNumber(),
            'compatible_systems' => $this->faker->word(),
            'compatible_versions' => $this->faker->words(),
            'license' => $this->faker->word(),
            'access_requirements' => $this->faker->words(),
            'links' => $this->faker->words(),
            'supported_languages' => $this->faker->words(),
            'product_icon' => $this->faker->word(),
            'product_banner' => $this->faker->word(),
            'created_at' => Carbon::now(),
            'updated_at' => Carbon::now(),
        ];
    }
}
