<?php

namespace App\Http\Resources;

use App\Helpers\Searchable;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin Searchable */
class SearchResource extends JsonResource {
    public function toArray(Request $request): array {
        return $this->search_response;
    }
}
