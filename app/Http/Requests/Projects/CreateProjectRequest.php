<?php

namespace App\Http\Requests\Projects;

use Illuminate\Foundation\Http\FormRequest;

class CreateProjectRequest extends FormRequest {
    public function rules(): array {
        return [
            'name' => ['required', 'string'],
            'tagline' => ['required', 'string'],
            'description' => ['required', 'string'],
            'display_image' => ['required', 'image'],
            'body' => ['required', 'string'],
        ];
    }

    public function authorize(): bool {
        return (auth()->user()->email ?? '') === 'imfran@duck.com';
    }
}
