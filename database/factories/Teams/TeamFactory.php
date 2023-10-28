<?php

namespace Database\Factories\Teams;

use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

class TeamFactory extends Factory {


    /*
    Emails format example:
    [
    {"label": "Work", "value": "work@example.org"},
    {"label": "Personal", "value": "john.doe@example.org"}
    ]

    Links format example:
    [
    {"icon": "fab fa-twitter", "label": "Twitter", "value": "https://twitter.com/"},
    {"icon": "fab fa-facebook", "label": "Facebook", "value": "https://facebook.com/"},
    {"icon": "fab fa-instagram", "label": "Instagram", "value": "https://instagram.com/"},
    {"icon": "fab fa-linkedin", "label": "LinkedIn", "value": "https://linkedin.com/"},
    {"icon": "fab fa-github", "label": "GitHub", "value": "https://github.com/"},
    {"icon": "fab fa-gitlab", "label": "GitLab", "value": "https://gitlab.com/"},
    {"icon": "fab fa-bitbucket", "label": "BitBucket", "value": "https://bitbucket.org/"},
    {"icon": "fab fa-stack-overflow", "label": "StackOverflow", "value": "https://stackoverflow.com/"},
     */

    // Now write the same links from the format example above
    private array $links = [
        ["icon" => "fab fa-twitter", "label" => "Twitter", "value" => "https://twitter.com/"],
        ["icon" => "fab fa-facebook", "label" => "Facebook", "value" => "https://facebook.com/"],
        ["icon" => "fab fa-instagram", "label" => "Instagram", "value" => "https://instagram.com/"],
        ["icon" => "fab fa-linkedin", "label" => "LinkedIn", "value" => "https://linkedin.com/"],
        ["icon" => "fab fa-github", "label" => "GitHub", "value" => "https://github.com/"],
        ["icon" => "fab fa-gitlab", "label" => "GitLab", "value" => "https://gitlab.com/"],
        ["icon" => "fab fa-bitbucket", "label" => "BitBucket", "value" => "https://bitbucket.org/"],
        ["icon" => "fab fa-stack-overflow", "label" => "StackOverflow", "value" => "https://stackoverflow.com/"],
    ];

    public function definition(): array {
        return [
            'user_id' => User::inRandomOrder()->first(['id'])->id,
            'name' => $this->faker->name(),
            'bio' => $this->faker->paragraphs(2, asText: true),
            'website' => $this->faker->boolean() ? $this->faker->url() : null,
            'links' => $this->faker->randomElements($this->links, $this->faker->numberBetween(1, 6)),
            'emails' => [
                ['label' => 'Contact', 'value' => $this->faker->safeEmail(), 'visible' => true],
                ['label' => 'CEO Office', 'value' => $this->faker->safeEmail(), 'visible' => true],
                ['label' => 'CTO Office', 'value' => $this->faker->safeEmail(), 'visible' => true],
                ['label' => 'CTO Office (Old Building)', 'value' => $this->faker->safeEmail(), 'visible' => false],
            ],
            'created_at' => $this->faker->dateTimeBetween('-2 year'),
            'updated_at' => $this->faker->dateTimeBetween('-1 year'),
        ];
    }
}
