<?php

namespace App\Models\Teams;

use App\Models\User;
use Cog\Contracts\Ownership\CanBeOwner;
use Illuminate\Database\Eloquent\Casts\AsCollection;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\SoftDeletes;
use Spatie\Sluggable\HasSlug;
use Spatie\Sluggable\SlugOptions;

/**
 * Documentation of Team Model:
 *
 * Columns:
 * - `user_id`: ID of the user who owns the team
 * - `name`: Name of the team
 * - `slug`: Slug of the team. Used for SEO.
 * - `bio`: Bio of the team.
 * - `website`: Website of the team.
 * - `links`: Links of the team.
 * - `emails`: Emails of the team, for example, billing, support, etc.
 */
class Team extends Model implements CanBeOwner {
    use HasFactory,
        HasSlug,
        HasUlids,
        SoftDeletes;

    protected $fillable = [
        'user_id',
        'name',
        'slug',
        'bio',
        'website',
        'links',
        'emails',
    ];

    protected $casts = [
        'links' => AsCollection::class,
        'emails' => AsCollection::class,
    ];

    protected static function booted(): void {
        static::created(function ($team) {
            $team->members()->attach(auth()->id());
        });
    }

    /* Stubs */
    public function getSlugOptions(): SlugOptions {
        return SlugOptions::create()
            ->generateSlugsFrom('name')
            ->saveSlugsTo('slug');
    }

    /* Relationships */
    public function user(): BelongsTo {
        return $this->belongsTo(User::class);
    }

    public function members(): BelongsToMany {
        return $this->belongsToMany(User::class, 'team_members', 'team_id', 'user_id');
    }
}
