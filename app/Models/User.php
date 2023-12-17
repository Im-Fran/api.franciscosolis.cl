<?php

namespace App\Models;

use App\Models\Teams\Team;
use Cog\Contracts\Ownership\CanBeOwner;
use Illuminate\Contracts\Auth\MustVerifyEmail;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;
use Spatie\Sluggable\HasSlug;
use Spatie\Sluggable\SlugOptions;

class User extends Authenticatable implements CanBeOwner, MustVerifyEmail {
    use HasApiTokens,
        HasFactory,
        HasSlug,
        HasUlids,
        Notifiable;

    protected $fillable = [
        'name',
        'slug',
        'email',
        'password',
    ];

    protected $hidden = [
        'password',
        'remember_token',
    ];

    protected $casts = [
        'email_verified_at' => 'datetime',
        'password' => 'hashed',
    ];

    public function getSlugOptions(): SlugOptions {
        return SlugOptions::create()
            ->generateSlugsFrom('name')
            ->saveSlugsTo('slug');
    }

    public function teams(): BelongsToMany {
        return $this->belongsToMany(Team::class, 'team_members', 'user_id', 'team_id');
    }
}
