<?php

namespace App\Http\Requests\Teams;

use Illuminate\Foundation\Http\FormRequest;

class CreateTeamRequest extends FormRequest {

    public function rules(): array {
        return [
            'name' => ['required', 'unique:teams,name'],
            'bio' => ['required'],
            'website' => ['nullable'],
            'emails.*.label' => ['required', 'string'],
            'emails.*.value' => ['required', 'email:rfc,dns'],
            'links.*.icon' => ['required', 'string'],
            'links.*.label' => ['required', 'string'],
        ];
    }

    public function authorize(): bool {
        return true;
    }
}
