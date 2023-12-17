<?php

namespace App\Http\Resources;

use App\Models\Teams\Team;
use App\Traits\ResourceFilterable;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin Team */
class TeamResource extends JsonResource {
    use ResourceFilterable;

    public function toArray(Request $request): array {
        if ($this->members()->whereId(auth()->id())->exists()) {
            return parent::toArray($request);
        }

        return $this->fields([
            'id' => $this->id,
            'user_id' => $this->user_id,
            'user' => new UserResource($this->whenLoaded('user')),
            'name' => $this->name,
            'slug' => $this->slug,
            'bio' => $this->bio,
            'website' => $this->website,
            'links' => $this->links,
            'members' => UserResource::collection($this->whenLoaded('members')),
            'created_at' => $this->created_at,
            'updated_at' => $this->updated_at,
        ]);
    }
}
