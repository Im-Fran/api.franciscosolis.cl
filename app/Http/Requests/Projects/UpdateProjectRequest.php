<?php

namespace App\Http\Requests\Projects;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class UpdateProjectRequest extends FormRequest {
    public function rules(): array {
        return [
            'name' => ['string', Rule::unique('projects')->ignore($this->project->id)],
            'tagline' => ['string'],
            'description' => ['string'],
            'display_image' => ['image'],
            'body' => ['string'],
        ];
    }

    public function authorize(): bool {
        return (auth()->user()->email ?? '') === 'imfran@duck.com';
    }
}
