<?php

namespace App\Http\Resources\Projects;

use App\Models\Projects\Project;
use App\Traits\Resources\FilterableResource;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin Project */
class ProjectResource extends JsonResource {
    use FilterableResource;

    public function toArray(Request $request): array {
        return $this->fields([
            'name' => $this->name,
            'slug' => $this->slug,
            'tagline' => $this->tagline,
            'description' => $this->description,
            'display_image' => $this->display_image,
            'body' => $this->body,
            'created_at' => $this->created_at,
            'updated_at' => $this->updated_at,
        ]);
    }
}
